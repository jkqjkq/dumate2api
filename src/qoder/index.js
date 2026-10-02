// src/qoder/index.js - Qoder 通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道。
//
// 与千问办公的关键差异：**签名在进程内完成**（cosy.js），不需要 spawn 子进程
// 调 wasm。所以这条通道没有「签名阻塞事件循环」的问题，代码也简单得多。
//
// 每次请求都要用**该账号的**身份构造一个新的 COSY 会话（cosyKey/info 与
// uid/token 绑定），这也是为什么 buildBody 与签名放在同一次 runOnce 里。
const https = require('https');
const crypto = require('crypto');
const chat = require('./chat');
const cosy = require('./cosy');
const authStore = require('./auth');
const session = require('./session');
const constants = require('./constants');

/** 预热：Qoder 无 wasm 依赖，只检查有没有可用账号 */
function warmup() {
  return status();
}

function status() {
  const usable = authStore.findUsable();
  return {
    ready: usable.length > 0,
    // 这条通道没有 wasm 依赖，如实标注（千问的 status 有 wasm 字段）
    needsClient: false,
    accounts: usable.length,
    error: usable.length ? '' : '尚未添加 Qoder 账号（需先登录一次）',
  };
}

function pickAccount() {
  const a = authStore.preferred();
  if (!a) throw new Error('Qoder 没有可用账号，请先添加一个');
  return a;
}

function nextAccount(exclude) {
  return authStore.findUsable().filter((a) => !exclude.has(a.id));
}

/**
 * 这个错误换账号还有救吗？
 *
 * 判据与千问同一思路：4xx（除 401/402/429/403-模型不可用）是请求本身的问题，
 * 换号也只是再失败一次。**只按数字 code 判，不匹配 message**。
 *
 * Qoder 特有：**额度耗尽时请求会挂起（不报错）**，所以这里看不到 402；
 * 真正会看到的是 `Login expired`（105，凭证失效，换号有用）与模型不可用。
 */
function retryable(code, message) {
  const n = Number(code);
  if (!Number.isFinite(n) || n === 0) return true; // 网络错误/超时：换号试一次
  if (n === 401 || n === 402 || n === 429) return true;
  if (n === 105) return true; // Login expired：凭证失效，换号有用
  if (n === 403) {
    return /not available|无权限|无权访问|login expired|expired/i.test(String(message || ''));
  }
  if (n >= 500) return true;
  return false;
}

function markFailure(account, msg) {
  try { authStore.patch(account.id, { lastError: String(msg).slice(0, 200) }); }
  catch (e) { /* 记不下不影响主流程 */ }
}

/**
 * 用指定账号跑一次请求。
 *
 * 与千问的 runOnce 结构对应，但签名是本地调用：
 *   buildBody → cosy.encode → newSession(该账号身份) → buildHeaders → post
 */
async function runOnce(account, payload, onChunk, opts) {
  const auth = await session.ensureAccount(authStore, account);
  const region = constants.normalizeRegion(auth.region);
  const ep = constants.endpointsOf(region);
  const modelKey = chat.resolveModelKey(payload && payload.model);

  const bodyJson = chat.buildBody(modelKey, payload);
  const encBody = cosy.encode(Buffer.from(bodyJson));

  // COSY 会话与账号身份绑定：uid / device_token 都进签名。
  // machineId/Token/Type 每账号一份（登录时生成并持久化）。
  const sess = cosy.newSession({
    name: auth.nickname || '',
    aid: auth.uid || '',
    uid: auth.uid || '',
    yxUid: '',
    organizationId: '',
    organizationName: '',
    userType: auth.userType || 'personal_standard',
    securityOauthToken: auth.accessToken,
    refreshToken: auth.refreshToken,
  }, auth.machineId || '', auth.machineToken || '', auth.machineType || '5');

  const headers = cosy.buildHeaders(sess, ep.ChatPathSig, encBody, 'text/event-stream', {
    'accept-encoding': 'identity',
    // 模型 key 必须同时放请求头——实测只放 body 时上游仍走 auto
    'x-model-key': modelKey,
    'x-model-source': 'system',
  });

  const startedAt = Date.now();
  try {
    if (onChunk) {
      let firstErr = null;
      let sent = false;
      const res = await chat.postStream(ep.ChatStreamURL, encBody, headers, (inner) => {
        if (firstErr) return;
        try {
          const err = chat.payloadError(JSON.parse(inner));
          if (err) { firstErr = err; return; }
        } catch (e) { /* 正常数据帧 */ }
        sent = true;
        onChunk(inner);
      });
      if (firstErr) {
        const err = new Error(`qoder ${firstErr.code}: ${firstErr.message}`);
        err.statusCode = firstErr.code;
        err.sent = sent;
        throw err;
      }
      return res;
    }
    const res = await chat.post(ep.ChatStreamURL, encBody, headers);
    const es = chat.envelopeStatus(res.raw);
    if (es && es.code >= 400) {
      const err = new Error(`qoder ${es.code}: ${es.message}`);
      err.statusCode = es.code;
      throw err;
    }
    const payloads = [];
    for (const line of String(res.raw || '').split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;
      payloads.push(...chat.unwrap(raw));
    }
    const out = chat.aggregate(payloads, modelKey);
    if (opts && opts.onAccount) { /* 非流式也报一次 */ }
    return out;
  } catch (e) {
    // 网络错误没有 statusCode，标记一下让上层知道可以换号
    if (!e.statusCode) e.statusCode = 0;
    throw e;
  }
}

/** 一次请求最多试几个账号。Qoder 签名是纯本地计算，代价低，可以放宽到 3 */
const MAX_ATTEMPTS = 3;

/**
 * 发对话请求。主账号失败且错误「换号有救」时，按可用列表顺序转移。
 */
async function send(payload, onChunk, opts = {}) {
  const tried = new Set();
  const errors = [];
  let account = pickAccount();

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    tried.add(account.id);
    if (opts.onAccount) {
      const name = account.nickname || account.uid || `账号 ${account.id}`;
      try { opts.onAccount(name); } catch (e) { /* 上报失败不影响请求 */ }
    }
    try {
      const result = await runOnce(account, payload, onChunk, opts);
      // 成功即清除上次的失败标记（与千问同一约定：一次瞬时失败不该永远挂着）
      if (account.lastError) {
        try { authStore.patch(account.id, { lastError: '' }); }
        catch (e) { /* 忽略 */ }
      }
      return result;
    } catch (e) {
      const code = Number(e.statusCode) || 0;
      markFailure(account, e.message);
      errors.push({ account: account.nickname || account.uid || account.id, status: code || '-', error: e.message });
      if (e.sent) throw e; // 流式已吐帧，不能再换号
      if (!retryable(code, e.message)) throw e;
      const rest = nextAccount(tried);
      if (!rest.length) break;
      account = rest[0];
    }
  }

  const err = new Error(`Qoder 所有账号均失败：${errors.map((x) => `${x.account}(${x.status})`).join('；')}`);
  err.statusCode = Number(errors[errors.length - 1].status) || 502;
  throw err;
}

/**
 * 模型列表：问服务端，失败回落静态表。
 *
 * 复用 session.fetchModels（带 5 分钟缓存）——**不要在这里重写一遍拉取逻辑**，
 * 否则 model-info 与管理端会各拿一份形状不同的表。
 */
async function listModels() {
  const entries = await listModelEntries();
  return entries.map((e) => e.id.slice('qoder/'.length));
}

/**
 * 模型条目：**带真实显示名与上下文**。
 *
 * 为什么单独一个方法：`/v1/models` 要的不只是 id 列表——cc-switch 解析模型
 * 列表时读的是 `name` 字段（实测其二进制里与 `owned_by` 相邻的字段是
 * id / name / cost / contextWindow / maxContextWindow）。只给 `{id, owned_by}`
 * 的话客户端只能显示内部 key（`qoder/qfmodel`），看不出是哪个模型。
 *
 * 上下文也带上：cc-switch 会读它；声明虚高会让客户端到接近上限才压缩历史，
 * 而 Qoder 多数模型只有 180K。
 */
async function listModelEntries() {
  try {
    const account = authStore.preferred();
    if (account) {
      const r = await session.fetchModels(account);
      if (r.ok && r.models.length) {
        // 顺手告诉 model-info 上游下发的完整表（带倍率），界面据此标「上游下发」
        try { require('../model-info').setQoderModels(r.models); } catch (e) { /* 不影响返回 */ }
        return r.models.map((m) => ({
          id: `qoder/${m.key}`,
          name: m.name || m.key,
          contextWindow: m.contextWindow || null,
          maxContextWindow: m.contextWindow || null,
        }));
      }
    }
  } catch (e) { /* 拿不到就用兜底 */ }
  return constants.FALLBACK_MODELS.map((k) => ({
    id: `qoder/${k}`, name: k, contextWindow: null, maxContextWindow: null,
  }));
}

/** 账号的额度与签到（管理端用） */
function checkin(account) {
  const a = account || pickAccount();
  // 把账号传下去：签到成功时顺手写本地批次账本（过期提醒的数据源）
  return session.checkin(a.accessToken, a.region, { account: a });
}

function quota(account) {
  const a = account || pickAccount();
  return session.fetchQuota(a.accessToken, a.region);
}

module.exports = {
  warmup, status, send, listModels, listModelEntries, pickAccount, checkin, quota,
  chatCompletion: (p, opts) => send(p, undefined, opts),
  chatCompletionStream: (p, cb, opts) => send(p, cb, opts),
};
