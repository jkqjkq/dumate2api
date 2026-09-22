// src/web-pool.js - 网页凭证账号池（token 管理 + 轮询 + 故障转移）
//
// 与本地后端链路的区别：那条路依赖 dumate-main-server.exe 且它同一时刻只有
// 一份登录态；这条路用网页 cookie 直接换 token 调云端网关，可以多账号并存。
//
// 实测（2026-09-22）：
//   GET  https://www.dumate.cn/api/dumate/app/token/get   → { token, expired_at }
//   POST https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions
//        Authorization: Bearer <token>
//   流式与非流式都可用，token 有效期约 1 小时，服务端会缓存（同一 token 同一过期时间）。
//
// 调度策略选「轮询 + 故障转移」而不是参考项目那套三因子加权随机：那套是为
// 几十上百个账号打散热点设计的，这里账号数是个位数，可预测性比打散更重要。
const https = require('https');
const crypto = require('crypto');
const accounts = require('./accounts');

const WEB_BASE = process.env.DUMATE_WEB_BASE || 'https://www.dumate.cn';
const GATEWAY_HOST = process.env.DUMATE_GATEWAY_HOST || 'dumate-svc.baidu.com';
const GATEWAY_PREFIX = '/gateway/apis/v1';
const TOKEN_TIMEOUT = 15000;

// token 提前刷新的余量：留 5 分钟，避免请求刚好压在过期点上
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// 连续失败多少次进入冷却
const FAIL_THRESHOLD = 3;
const COOLDOWN_MS = 5 * 60 * 1000;

// 每个账号的运行态。按 id 索引，不落盘——重启后重新探测即可，
// 落盘反而会把「上次失败」的陈旧状态带过来。
const runtime = new Map();

function stateOf(id) {
  if (!runtime.has(id)) {
    runtime.set(id, {
      token: null,
      token_expire_at: 0,
      ok_count: 0,
      fail_count: 0,
      consecutive_fails: 0,
      cooldown_until: 0,
      last_used_at: 0,
      last_error: '',
      refreshing: null,
    });
  }
  return runtime.get(id);
}

function httpsJSON(hostname, path, method, headers, body, timeout = 30000) {
  return new Promise((resolve) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path,
        method,
        timeout,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { json = null; }
          resolve({ status: res.statusCode, json, raw: json ? null : data.slice(0, 300) });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, json: null, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// 取（或复用）某账号的 token。并发调用共享同一次刷新，避免同时打多个
// token 请求——服务端虽然会缓存，但并发刷新没有意义。
async function getToken(account, force = false) {
  const st = stateOf(account.id);
  const now = Date.now();

  if (!force && st.token && st.token_expire_at - REFRESH_SKEW_MS > now) {
    return { ok: true, token: st.token, cached: true };
  }

  if (st.refreshing) return st.refreshing;

  st.refreshing = (async () => {
    const r = await httpsJSON(WEB_BASE.replace(/^https?:\/\//, ''), '/api/dumate/app/token/get',
      'GET', { Cookie: account.cookie }, null, TOKEN_TIMEOUT);

    if (r.status !== 200 || !r.json || !r.json.result || !r.json.result.token) {
      const msg = r.json && r.json.message ? r.json.message : (r.raw || `HTTP ${r.status}`);
      st.last_error = `取 token 失败：${msg}`;
      return { ok: false, error: st.last_error, expired: r.status === 401 };
    }

    const res = r.json.result;
    st.token = res.token;
    // expired_at 是 ISO 时间；解析失败就按 50 分钟兜底，宁可早刷不要晚刷
    const t = res.expired_at ? Date.parse(res.expired_at) : NaN;
    st.token_expire_at = Number.isFinite(t) ? t : now + 50 * 60 * 1000;
    st.last_error = '';
    return { ok: true, token: st.token, cached: false };
  })();

  try {
    return await st.refreshing;
  } finally {
    st.refreshing = null;
  }
}

// 可选账号：启用的、不在冷却期的
function candidates() {
  const now = Date.now();
  return accounts.load().accounts
    .filter((a) => a.enabled)
    .map((a) => ({ account: a, st: stateOf(a.id) }))
    .filter(({ st }) => st.cooldown_until <= now);
}

function markSuccess(id) {
  const st = stateOf(id);
  st.ok_count++;
  st.consecutive_fails = 0;
  st.last_error = '';
  st.last_used_at = Date.now();
}

function markFailure(id, reason) {
  const st = stateOf(id);
  st.fail_count++;
  st.consecutive_fails++;
  st.last_error = String(reason || '').slice(0, 200);
  st.last_used_at = Date.now();
  // 连续失败到阈值就冷却。单个失败不冷却——上游偶发抖动不该让账号下线，
  // 而且立刻冷却会在账号少时把池子打空。
  if (st.consecutive_fails >= FAIL_THRESHOLD) {
    st.cooldown_until = Date.now() + COOLDOWN_MS;
  }
}

// 轮询游标。进程内单调递增，重启归零——对轮询来说无所谓。
let cursor = 0;

// 选下一个账号。exclude 用于故障转移时跳过本次已试过的。
function pick(exclude = new Set()) {
  const list = candidates().filter(({ account }) => !exclude.has(account.id));
  if (!list.length) return null;
  const item = list[cursor % list.length];
  cursor = (cursor + 1) % 1e9;
  return item;
}

// 调云端模型网关。返回 { ok, status, json, raw, account }。
async function callModel(account, path, method, body, opts = {}) {
  const t = await getToken(account, opts.forceToken);
  if (!t.ok) return { ok: false, status: 401, error: t.error, expired: t.expired };

  const r = await httpsJSON(GATEWAY_HOST, GATEWAY_PREFIX + path, method, {
    Authorization: `Bearer ${t.token}`,
    // 与桌面客户端一致：标记来源与账号域
    'X-Dumate-Client-Type': 'web',
    'X-Dumate-Account-Id': 'global',
  }, body, opts.timeout || 600000);

  // token 失效：强制刷一次再重试一次。不无限重试——真失效（cookie 过期）
  // 时重试再多次也没用，只会放大延迟。
  if (r.status === 401 && !opts._retried) {
    return callModel(account, path, method, body, { ...opts, forceToken: true, _retried: true });
  }

  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: r.json, raw: r.raw, account };
}

// 带故障转移的调用：从轮询位置起依次尝试，直到成功或全部失败。
async function callWithFailover(path, method, body, opts = {}) {
  const tried = new Set();
  const errors = [];
  const maxAttempts = Math.max(1, opts.maxAttempts || 3);

  for (let i = 0; i < maxAttempts; i++) {
    const item = pick(tried);
    if (!item) break;
    tried.add(item.account.id);

    const r = await callModel(item.account, path, method, body, opts);
    if (r.ok) {
      markSuccess(item.account.id);
      return { ...r, attempts: i + 1 };
    }

    // 4xx（除 401）是请求本身的问题，换账号也一样失败——直接返回，
    // 不要为了一个必然失败的请求把所有账号都试一遍
    if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) {
      return { ...r, attempts: i + 1, no_retry: true };
    }

    markFailure(item.account.id, r.error || (r.json && r.json.error && r.json.error.message) || `HTTP ${r.status}`);
    errors.push({ account: item.account.name, status: r.status, error: r.last_error || r.error });
  }

  return {
    ok: false,
    status: errors.length ? 502 : 503,
    error: errors.length ? '所有账号均调用失败' : '没有可用账号（全部禁用或冷却中）',
    errors,
    attempts: tried.size,
  };
}

// 池状态快照，供管理端展示
function snapshot() {
  const now = Date.now();
  return accounts.load().accounts.map((a) => {
    const st = stateOf(a.id);
    return {
      id: a.id,
      name: a.name,
      nickname: a.nickname || '',
      enabled: a.enabled,
      has_token: !!st.token,
      token_expire_at: st.token_expire_at || null,
      token_expires_in_s: st.token_expire_at ? Math.max(0, Math.round((st.token_expire_at - now) / 1000)) : null,
      cooldown_until: st.cooldown_until || 0,
      cooling: st.cooldown_until > now,
      ok_count: st.ok_count,
      fail_count: st.fail_count,
      consecutive_fails: st.consecutive_fails,
      last_used_at: st.last_used_at || null,
      last_error: st.last_error,
    };
  });
}

// 探测某个账号是否可用（管理端「测试」按钮）
async function probe(id) {
  const a = accounts.load().accounts.find((x) => x.id === Number(id));
  if (!a) return { ok: false, error: '账号不存在' };
  const t = await getToken(a, true);
  if (!t.ok) return { ok: false, error: t.error };
  const r = await callModel(a, '/chat/completions', 'POST',
    { model: 'model-text', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
  if (r.ok) markSuccess(a.id); else markFailure(a.id, r.error);
  return { ok: r.ok, status: r.status, error: r.error, model: r.json && r.json.model };
}

// 清掉某账号的运行态（删除账号时调用，避免 Map 泄漏）
function forget(id) {
  runtime.delete(Number(id));
}

module.exports = {
  getToken, callWithFailover, callModel, pick, snapshot, probe, forget,
  GATEWAY_HOST, GATEWAY_PREFIX, stateOf,
};
