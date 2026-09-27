// src/admin/routes/qwenwork.js - 千问办公通道：账号、积分、状态、模型
//
// 2026-09-25 改：这条通道的凭证不再来自官方客户端的 auth-v2.dat，而是
// 我们自己走 device flow 换来的、存在 data/qwenwork-accounts.json 里
// （见 src/qwenwork/auth.js 与 login.js）。所以账号从「单账号只读」变成
// 「多账号可增删」，与 TRAE Work 路由（traework.js）同构。
//
// **对外响应形状保持**：前端三个页面（登录态 / 账号管理 / 仪表盘）在按现有
// 字段渲染，这里只换取值来源，不换字段。
const { sendJSON } = require('../router');
const authStore = require('../../qwenwork/auth');
const login = require('../../qwenwork/login');
const credits = require('../../qwenwork/credits');

// 缓存：余额要打站点接口，仪表盘刷新不该每次都穿透。
// 按账号分桶——缓存里存的是「谁有多少」，混在一起会张冠李戴。
let cache = { at: 0, data: new Map() };
const CACHE_MS = 15000;

/** 免费额度每天 00:00 (+08:00) 重置——重置时刻接口给了（wallet 的 valid_to） */
function resetAt(w) {
  const list = w && w.expiring ? w.expiring : [];
  for (const x of list) if (x && x.valid_to) return x.valid_to;
  return null;
}

/** 主账号的余额（带 15s 缓存） */
async function walletsOf(account) {
  if (!account) return null;
  const key = String(account.id);
  const hit = cache.data.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.w;
  const w = await credits.fetchWallets({ account });
  cache.data.set(key, { at: Date.now(), w });
  cache.at = Date.now();
  return w;
}

/** 按天聚合归因历史。只聚合有 channel 概念之后的数据 */
function dailyUsage(days) {
  const c = require('../../qwenwork/credits');
  const rows = c.readHistory();
  const since = Date.now() - days * 86400000;
  const byDay = new Map();
  for (const r of rows) {
    if (!r || r.ts < since) continue;
    const d = new Date(r.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = byDay.get(key) || { day: key, free: 0, paid: 0, total: 0, requests: 0, concurrent: 0 };
    cur.free += r.free || 0;
    cur.paid += r.paid || 0;
    cur.total += r.total || 0;
    cur.requests += 1;
    if (r.concurrent) cur.concurrent += 1;
    byDay.set(key, cur);
  }
  // 补齐没有请求的日期，否则折线图会把间隔压掉
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = byDay.get(key) || { day: key, free: 0, paid: 0, total: 0, requests: 0, concurrent: 0 };
    out.push({
      day: key,
      free: Number(cur.free.toFixed(4)),
      paid: Number(cur.paid.toFixed(4)),
      total: Number(cur.total.toFixed(4)),
      requests: cur.requests,
      concurrent: cur.concurrent,
    });
  }
  return out;
}

function todayUsage() {
  const c = require('../../qwenwork/credits');
  const rows = c.readHistory();
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let free = 0; let paid = 0; let n = 0;
  for (const r of rows) {
    if (!r) continue;
    const rd = new Date(r.ts);
    const key = `${rd.getFullYear()}-${String(rd.getMonth() + 1).padStart(2, '0')}-${String(rd.getDate()).padStart(2, '0')}`;
    if (key !== today) continue;
    free += r.free || 0;
    paid += r.paid || 0;
    n += 1;
  }
  return { free: Number(free.toFixed(4)), paid: Number(paid.toFixed(4)), total: Number((free + paid).toFixed(4)), requests: n };
}

const NO_ACCOUNT = '尚未添加千问账号，请到账号管理添加（走浏览器登录，不需要开千问客户端）';

/**
 * 主账号的登录态视图。
 *
 * 形状与以前的「读客户端 auth-v2.dat」版本一致（前端在按这些字段渲染），
 * 只是取值换成账号池里的主账号。file/fileStat 不再有意义——没有客户端文件
 * 这个概念了，如实给 null 而不是编一个路径。
 */
function loginDetail() {
  const out = {
    ok: false,
    error: '',
    // 凭证来源现在是账号池文件，顺手报出来，排查「文件被清了」时用得上
    file: null,
    fileStat: null,
    machineId: '',
    account: null,
    token: { accessExpiresAt: null, refreshExpiresAt: null, accessExpired: false, refreshExpired: false },
    ready: false,
    wasm: null,
  };
  try {
    const w = require('../../qwenwork/wasm-path').resolveDetailed();
    out.wasm = w ? w.version : null;
  } catch (e) { /* wasm 找不到不影响读账号 */ }

  const a = authStore.preferred();
  if (!a) {
    out.error = NO_ACCOUNT;
    return out;
  }
  try {
    const fs = require('fs');
    const p = authStore.filePath();
    out.file = p;
    try {
      const st = fs.statSync(p);
      out.fileStat = { size: st.size, mtime: st.mtimeMs };
    } catch (e) { /* 读不到就留 null */ }
  } catch (e) { /* 路径取不到不影响主流程 */ }

  out.account = {
    id: a.uid || String(a.id),
    name: a.nickname || '',
    username: a.username || '',
    email: a.email || '',
    tier: a.tier || '',
    planName: a.planName || '',
    planId: a.planId || '',
    planSubscriptionActive: false,
    planNextDueDate: null,
    isBiz: false,
    orgName: null,
    // 页面额度（pageQuota / monthRequests / monthTraffic）来自 account-context 的
    // page 段，账号池里没存——不给就留 null，界面显示 —，不编数字
    entitlements: null,
  };
  const parse = (s) => {
    const t = Date.parse(s || '');
    return Number.isFinite(t) ? t : null;
  };
  const aExp = a.expiresAt || null;
  const rExp = a.refreshExpiresAt || parse(a.refreshExpiresAt) || null;
  out.token = {
    accessExpiresAt: aExp,
    refreshExpiresAt: rExp,
    accessExpired: aExp !== null && Date.now() >= aExp,
    refreshExpired: rExp !== null && Date.now() >= rExp,
  };
  out.machineId = a.machineId || '';
  out.ok = true;
  return out;
}

/** 积分逐笔明细：从归因历史读，按时间倒序 */
function creditRecords(limit) {
  const c = require('../../qwenwork/credits');
  const rows = c.readHistory();
  return rows
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
    .map((r) => ({
      ts: r.ts,
      req_id: r.req_id || '',
      model: r.model || '',
      ms: r.ms ?? null,
      free: r.free || 0,
      paid: r.paid || 0,
      total: r.total || 0,
      pool: r.pool || 'none',
      concurrent: !!r.concurrent,
      balance: r.balance || null,
      account: r.account || null,
    }));
}

const routes = [
  {
    method: 'GET',
    path: '/account',
    handler: async ({ req, res }) => {
      return sendJSON(res, 200, loginDetail());
    },
  },
  {
    method: 'GET',
    path: '/credits/records',
    handler: async ({ req, res }) => {
      const limit = Math.min(1000, Math.max(1, parseInt((req.url.match(/[?&]limit=(\d+)/) || [])[1] || '100', 10) || 100));
      const rows = creditRecords(limit);
      const sum = rows.reduce((s, r) => ({
        free: s.free + r.free, paid: s.paid + r.paid, total: s.total + r.total,
      }), { free: 0, paid: 0, total: 0 });
      return sendJSON(res, 200, {
        limit,
        rows,
        // 汇总只统计本次返回的窗口，界面要写清范围
        window: {
          free: Number(sum.free.toFixed(4)),
          paid: Number(sum.paid.toFixed(4)),
          total: Number(sum.total.toFixed(4)),
          requests: rows.length,
        },
      });
    },
  },
  {
    // 账号列表。多账号：可增删、可停用、可指定主账号
    method: 'GET',
    path: '/accounts',
    handler: async ({ req, res }) => {
      const d = loginDetail();
      const accounts = [];
      const all = authStore.list();
      for (const a of all) {
        let wallets = null;
        try {
          const w = await walletsOf(authStore.get(a.id));
          if (w && w.ok) wallets = { daily: w.daily, monthly: w.monthly, longterm: w.longterm, total: w.total };
        } catch (e) { /* 余额取不到不影响账号信息 */ }
        accounts.push({
          id: String(a.id),
          name: a.nickname || a.uid || `账号 ${a.id}`,
          username: a.username || '',
          email: a.email || '',
          // 只给脱敏形式（157****1251）。完整号码是 PII，留在账号文件里
          phone: a.phoneMasked || '',
          tier: a.tier || '',
          planName: a.planName || '',
          // active = 主账号（前端用它标「当前在用」）
          active: !!a.preferred,
          // 用 list() 带出的布尔判定，不要碰 refreshToken 本身（它没被外传）
          usable: a.enabled !== false && a.hasRefresh && a.hasAccess && !a.refreshExpired,
          enabled: a.enabled !== false,
          // 仪表盘账号健康快照：账号存活天数 + 总积分
          daysAlive: a.daysAlive,
          // 读上面查到的 wallets，不是 a.wallets——a 是 list() 的脱敏视图，
          // 它没有余额字段，写成 a.wallets 会让这里恒为 null
          points: wallets ? wallets.total : null,
          tokenExpiresAt: a.expiresAt || null,
          refreshExpiresAt: a.refreshExpiresAt || null,
          refreshExpired: !!(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt),
          machineId: a.machineId || '',
          lastError: a.lastError || '',
          refreshTail: a.refreshTail || '',
          wallets,
        });
      }
      return sendJSON(res, 200, {
        mode: 'multi',
        modeNote: '千问办公的凭证由本项目自行 device flow 换取并保存（data/qwenwork-accounts.json），可多账号并存、可增删；换账号不需要打开千问客户端。',
        count: accounts.length,
        accounts,
        error: accounts.length ? '' : (d.error || NO_ACCOUNT),
      });
    },
  },
  {
    // 发起一次登录：返回给用户打开的授权地址
    method: 'POST',
    path: '/login/start',
    handler: async ({ req, res }) => {
      try {
        return sendJSON(res, 200, login.startFlow());
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    },
  },
  {
    // 轮询取票。只查一次就返回——等待由前端定时调，不把 HTTP 请求挂 5 分钟
    method: 'POST',
    path: '/login/poll',
    handler: async ({ res, body }) => {
      const nonce = body && body.nonce;
      if (!nonce) return sendJSON(res, 400, { error: '缺少 nonce（需先调 /login/start）' });
      const r = await login.pollFlow(nonce);
      return sendJSON(res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/login/cancel',
    handler: async ({ res, body }) => {
      const nonce = body && body.nonce;
      if (!nonce) return sendJSON(res, 400, { error: '缺少 nonce' });
      login.cancelFlow(nonce);
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    // 回填手机号。加这个接口之前登录的账号没有 phone 字段，
    // 用这条补一次（对全部可用账号逐个问一次 identities）
    method: 'POST',
    path: '/accounts/refresh-phone',
    handler: async ({ res, body }) => {
      const id = body && body.id;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.findUsable();
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号' });
      const out = [];
      for (const a of list) {
        try {
          const p = await authStore.fetchPhone(a);
          if (p && p.phone) {
            authStore.patch(a.id, { phone: p.phone });
            out.push({ id: a.id, name: a.nickname || '', ok: true, phone: authStore.maskPhone(p.phone) });
          } else {
            out.push({ id: a.id, name: a.nickname || '', ok: false, error: '接口没返回手机号' });
          }
        } catch (e) {
          out.push({ id: a.id, name: a.nickname || '', ok: false, error: e.message });
        }
      }
      return sendJSON(res, 200, { ok: true, results: out });
    },
  },
  {
    method: 'DELETE',
    path: '/accounts/:id',
    handler: async ({ res, params }) => {
      const a = authStore.get(params[0]);
      const ok = authStore.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: '账号不存在' });
      // 基准/队列/缓存都按账号存着，删号后清掉，否则 Map 会一直涨
      try { require('../../qwenwork/credits').forget(a); } catch (e) { /* 清理失败不影响 */ }
      cache.data.delete(String(params[0]));
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    // 停用/启用 + 指定主账号。preferred 是排他的（authStore.patch 内部会清掉其他）
    method: 'PATCH',
    path: '/accounts/:id',
    handler: async ({ res, params, body }) => {
      const fields = {};
      if (body && body.enabled !== undefined) fields.enabled = !!body.enabled;
      if (body && body.preferred !== undefined) fields.preferred = !!body.preferred;
      if (!Object.keys(fields).length) return sendJSON(res, 400, { error: '没有可更新的字段' });
      const a = authStore.patch(params[0], fields);
      if (!a) return sendJSON(res, 404, { error: '账号不存在' });
      return sendJSON(res, 200, { ok: true, account: authStore.list().find((x) => x.id === a.id) });
    },
  },
  {
    method: 'GET',
    path: '/status',
    handler: async ({ req, res }) => {
      let st = { ready: false, error: '未加载', accounts: 0 };
      let acct = {};
      try {
        const qw = require('../../qwenwork');
        st = qw.status();
        const a = authStore.preferred();
        acct = a ? {
          account: a.nickname || a.uid || '',
          tier: a.tier || '',
          planId: a.planId || '',
          tokenExpiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
          refreshExpiresAt: a.refreshExpiresAt ? new Date(a.refreshExpiresAt).toISOString() : null,
          refreshExpired: !!(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt),
          tokenExpired: !!(a.expiresAt && Date.now() >= a.expiresAt),
        } : {};
      } catch (e) {
        st = { ready: false, error: e.message, accounts: 0 };
      }
      // token 绝不外传：只给到期时间与账号名
      return sendJSON(res, 200, {
        ready: st.ready,
        wasm: st.wasm ? st.wasm.version : null,
        loggedIn: !!st.loggedIn,
        error: st.error || '',
        accounts: st.accounts || 0,
        ...acct,
      });
    },
  },
  {
    method: 'GET',
    path: '/credits',
    handler: async ({ req, res }) => {
      try {
        const account = authStore.preferred();
        if (!account) return sendJSON(res, 200, { ok: false, error: NO_ACCOUNT });
        const w = await credits.fetchWallets({ account });
        if (!w.ok) return sendJSON(res, 200, { ok: false, error: w.error || '' });
        return sendJSON(res, 200, {
          ok: true,
          error: '',
          // 三个池子**平级**上报，不做「免费 vs 付费」的合并——
          // 月度与长期性质不同（订阅套餐 vs 充值赠送），界面要能分开看。
          wallets: [
            { id: 'daily', label: '每日额度', kind: 'free', balance: w.daily, resetAt: resetAt(w) },
            { id: 'monthly', label: '月度积分', kind: 'paid', balance: w.monthly, resetAt: null },
            { id: 'longterm', label: '长期积分', kind: 'paid', balance: w.longterm, resetAt: null },
          ],
          // 汇总：付费 = 月度 + 长期
          free: w.daily,
          paid: w.paid,
          monthly: w.monthly,
          longterm: w.longterm,
          total: w.total,
          // 上限由「观测峰值 + 配置兜底」得出（见 credits.dailyUsageFromBalance）。
          // 接口本身不给上限，所以 calibrated=false 表示还没观测到接近满额的
          // 状态，此时消耗值可能偏小——界面要如实标注，别让人当成精确值。
          limit: w.limit,
          limitSource: w.limitSource,
          peak: w.peak,
          calibrated: w.calibrated,
          // 每日免费额度的配置上限（默认 100）。界面上「免费额度 X / 100」
          // 的分子来自接口余额、分母来自配置——接口不给分母，必须标来源。
          dailyCap: require('../../qwenwork/credits').dailyLimit(),
          // 今日全部消耗（含客户端/网页里的对话，不只经网关的）
          freeUsed: w.freeUsed,
          // 今日经本网关的消耗（另一套口径，两者不要相加）
          today: { ...todayUsage(), scope: 'gateway' },
          expiring: w.expiring || [],
          fetchedAt: w.fetchedAt,
          // 是主账号的余额——多账号下必须说清是谁的
          account: account.nickname || account.uid || String(account.id),
        });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    },
  },
  {
    method: 'GET',
    path: '/credits/daily',
    handler: async ({ req, res }) => {
      const days = Math.min(90, Math.max(1, parseInt((req.url.match(/[?&]days=(\d+)/) || [])[1] || '14', 10) || 14));
      return sendJSON(res, 200, { days, rows: dailyUsage(days) });
    },
  },
  {
    method: 'GET',
    path: '/models',
    handler: async ({ req, res }) => {
      let models = [];
      let error = '';
      try {
        const qw = require('../../qwenwork');
        const keys = await qw.listModels();
        // 中文名来自上游 display_name（pro→高级 / flash→标准）。
        // 硬编码一份必然过期——1.1.0 实测模型表已与旧版不同。
        const names = { pro: '高级', flash: '标准', 'qwen3.8-max-preview': 'Qwen3.8-Max' };
        models = keys.map((k) => ({ id: k, name: names[k] || k, prefixed: `qwen/${k}` }));
      } catch (e) {
        error = e.message;
      }
      return sendJSON(res, 200, { models, error });
    },
  },
];

module.exports = { routes };
