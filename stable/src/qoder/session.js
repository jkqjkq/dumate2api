// src/qoder/session.js - token 续期、账号信息、额度、签到
//
// 与 chat.js（聊天）分开：这里都是**非签名**接口（只用 Bearer device_token），
// 聊天才需要 COSY 签名。分开的理由是两者的失败模式与调用时机不同——
// 这里在登录/刷新/管理端读状态时调用，聊天在每次推理时调用。
const https = require('https');
const c = require('./constants');

const TIMEOUT_MS = 20000;

/** 发一个 JSON 请求，返回 { status, data, raw }。永不抛（网络错当 status=0） */
function request(url, { method = 'GET', headers = {}, body = null, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, data: null, raw: '', error: e.message }); }
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { accept: 'application/json', 'accept-encoding': 'identity', ...headers };
    if (payload != null) {
      h['content-type'] = h['content-type'] || 'application/json';
      h['content-length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: h, timeout }, (res) => {
      let b = '';
      res.on('data', (chunk) => { b += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(b); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, data, raw: b });
      });
      res.on('error', (e) => resolve({ status: 0, data: null, raw: '', error: e.message }));
    });
    req.on('error', (e) => resolve({ status: 0, data: null, raw: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, raw: '', error: 'timeout' }); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** 带 device_token 的简单请求头 */
function bearerHeaders(token, extra) {
  return { Authorization: `Bearer ${token}`, ...(extra || {}) };
}

/**
 * 拉模型表（带缓存）。返回归一化后的列表，**含倍率 price_factor**。
 *
 * 模型表变化很慢（随上游版本），所以缓存 5 分钟。倍率是上游真值，界面
 * 据此排序/标注——**开发调试要挑 0.1 档**（档位差 14 倍）。
 */
const MODELS_CACHE_MS = parseInt(process.env.DUMATE_QODER_MODELS_CACHE_MS || '300000', 10);
// 缓存按「区域 + 账号」隔离。原先是一个模块级单例，两个后果都是实测踩到的：
//   1. **多账号互相串表**：preferred 账号只返回 2 个模型、另一个账号返回 14 个，
//      先查谁，后面所有账号都拿到那份表（「配置到 cc-switch」里 Qoder 只列出
//      2 个模型就是这个原因）。
//   2. **cn / global 跨区串表**：两个区域的模型集本来就不同（账号也不通用）。
const modelsCache = new Map(); // `${region}:${uid}` -> { at, data }

function modelsCacheKey(account) {
  const region = c.normalizeRegion(account && account.region);
  const who = (account && (account.uid || account.id)) || '';
  return `${region}:${who}`;
}

async function fetchModels(account, { force = false } = {}) {
  const ck = modelsCacheKey(account);
  const hit = modelsCache.get(ck);
  if (!force && hit && Date.now() - hit.at < MODELS_CACHE_MS) return hit.data;
  const cosy = require('./cosy');
  const region = c.normalizeRegion(account.region);
  const ep = c.endpointsOf(region);
  const sess = cosy.newSession({
    name: account.nickname || '', aid: account.uid || '', uid: account.uid || '',
    userType: account.userType || 'personal_standard',
    securityOauthToken: account.accessToken, refreshToken: account.refreshToken,
  }, account.machineId || '', account.machineToken || '', account.machineType || '5');
  const headers = cosy.buildHeaders(sess, ep.ModelsPathSig, '', 'application/json', { 'accept-encoding': 'identity' });
  const u = new URL(ep.ModelListURL);
  const r = await new Promise((resolve) => {
    const req = require('https').request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, timeout: 20000,
    }, (res) => {
      let b = ''; res.on('data', (x) => { b += x; }); res.on('end', () => resolve({ status: res.statusCode, raw: b }));
    });
    req.on('error', (e) => resolve({ status: 0, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, raw: 'timeout' }); });
    req.end();
  });
  if (r.status !== 200) return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}`, models: [] };
  let list;
  try { list = (JSON.parse(r.raw).chat || []); } catch (e) { return { ok: false, error: '响应不是 JSON', models: [] }; }
  const models = list.filter((m) => m && m.enable !== false).map((m) => ({
    key: m.key,
    name: m.display_name || m.key,
    prefixed: `qoder/${m.key}`,
    // 倍率是相对值，不是积分绝对值
    rate: typeof m.price_factor === 'number' ? m.price_factor : null,
    // 原价倍率：**错峰/免费模型的 price_factor 会是 0**（实测 qfmodel=0、
    // original_price_factor=0.1）。只给 rate 会被读成「完全不扣费」，所以两个都带，
    // 界面在 rate 为 0 时并列显示原价。
    rateOriginal: typeof m.original_price_factor === 'number' ? m.original_price_factor : null,
    contextWindow: m.max_input_tokens || null,
    isDefault: m.is_default === true,
    isFree: m.is_free === true,
    isNew: m.is_new === true,
    isReasoning: m.is_reasoning === true,
    multimodal: m.is_vl === true,
    // 错峰优惠：22:00-08:00 打折
    promotion: (m.promotion && m.promotion.active) ? {
      discountFactor: m.promotion.discount_factor || null,
      windowStart: m.promotion.window_start || '',
      windowEnd: m.promotion.window_end || '',
    } : null,
    cheap: typeof m.price_factor === 'number' && m.price_factor <= 0.1,
  }));
  const out = { ok: true, error: '', models };
  if (models.length) modelsCache.set(ck, { at: Date.now(), data: out });
  return out;
}

/**
 * 用 refresh_token 换新的 device_token。
 *
 * **refresh token 是轮换的**：每次返回新的，必须存下来。实测（2026-10-02）：
 * 新 device_token 有效期 30 天，refresh_token 有效期约 1 年。
 *
 * 不落盘：返回 patch 字段由调用方写回，保持「读-改-写」在一次调用里，
 * 避免并发刷新时后写的覆盖先写的（与 qwenwork/auth.js 同一约定）。
 */
async function exchange(account) {
  if (!account || !account.refreshToken) return { ok: false, error: '缺少 refreshToken' };
  const ep = c.endpointsOf(account.region);
  const r = await request(ep.RefreshEndpoint, {
    method: 'POST',
    headers: { 'User-Agent': 'qoder/1.0.0', 'Login-Version': c.LOGIN_VERSION },
    body: { refresh_token: account.refreshToken, target: 'c' },
  });
  if (r.status !== 200 || !r.data) {
    // refresh 失败通常是凭证本身失效（refresh token 过期/被吊销）——
    // 该做的是重新登录，不是查网络。所以报错文案要指向重登。
    const detail = (r.data && (r.data.message || r.data.error)) || String(r.raw || '').slice(0, 120) || r.error || `HTTP ${r.status}`;
    return { ok: false, error: `换票失败（${detail}）`, expired: true };
  }
  const token = r.data.device_token || r.data.token || '';
  if (!token) return { ok: false, error: '换票未返回 device_token', expired: true };
  const out = { accessToken: token };
  if (r.data.refresh_token) out.refreshToken = r.data.refresh_token;
  // 到期时间：优先用服务端给的 expires_at
  if (r.data.expires_at) {
    const t = Date.parse(r.data.expires_at);
    if (Number.isFinite(t)) out.expiresAt = t;
  }
  if (r.data.refresh_token_expires_at) {
    const t = Date.parse(r.data.refresh_token_expires_at);
    if (Number.isFinite(t)) out.refreshExpiresAt = t;
  }
  out.lastError = '';
  return { ok: true, patch: out };
}

/**
 * 确保账号的 token 新鲜。需要刷新时刷新并写回。
 * 与 qwenwork/chat.js 的 ensureAccount 同构。
 */
async function ensureAccount(authStore, account) {
  if (!authStore.needsRefresh(account)) return account;
  const r = await exchange(account);
  if (!r.ok) {
    authStore.patch(account.id, { lastError: `换票失败: ${r.error}` });
    const err = new Error(`Qoder token 换票失败: ${r.error}`);
    err.statusCode = 401;
    throw err;
  }
  authStore.patch(account.id, r.patch);
  return authStore.get(account.id) || { ...account, ...r.patch };
}

/** 取用户信息（登录后 / 补昵称时用） */
async function fetchUserInfo(token, region) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.UserinfoBase, { headers: bearerHeaders(token) });
  if (r.status !== 200 || !r.data) return null;
  return r.data;
}

/** 取套餐信息 */
async function fetchPlan(token, region) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.PlanEndpoint, { headers: bearerHeaders(token) });
  if (r.status !== 200 || !r.data) return null;
  return r.data;
}

/**
 * 取额度。
 *
 * 返回三块，**语义不同，界面不能相加**：
 *   - userQuota     订阅套餐内的额度（Free 套餐恒为 0）
 *   - addOnQuota    签到/赠送得到的积分（**这才是免费用户实际能用的**）
 *   - isQuotaExceeded 是否已超额（超额时聊天会挂起而非报错，见下）
 *
 * 实测（2026-10-02）：新账号 userQuota 与 addOnQuota 都是 0，
 * 此时聊天请求**会挂起不返回**（既不报错也不超时失败），必须先签到领积分。
 */
async function fetchQuota(token, region) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.QuotaEndpoint, { headers: bearerHeaders(token, { 'cosy-clienttype': c.CHECKIN_CLIENT_TYPE }) });
  if (r.status !== 200 || !r.data) return { ok: false, error: r.error || `HTTP ${r.status}` };
  const bucket = (o) => {
    if (!o || typeof o !== 'object') return null;
    const total = num(o.total), used = num(o.used), remaining = num(o.remaining);
    return { total, used, remaining, percentage: num(o.percentage), unit: o.unit || 'credits' };
  };
  return {
    ok: true,
    userQuota: bucket(r.data.userQuota),
    addOnQuota: bucket(r.data.addOnQuota),
    isQuotaExceeded: r.data.isQuotaExceeded === true,
    userType: r.data.userType || '',
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 签到：查活动列表 → 领取可领的。
 *
 * **这条接口不需要签名**（实测）：只要 `Authorization: Bearer <device_token>`
 * + `cosy-clienttype: 10`。比聊天简单得多。
 *
 * 幂等：已领的活动 claimStatus 不是 CLAIMABLE，会跳过；重复调用不会重复领。
 */
async function listCampaigns(token, region) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.CampaignsBase, { headers: bearerHeaders(token, { 'cosy-clienttype': c.CHECKIN_CLIENT_TYPE }) });
  if (r.status !== 200 || !r.data) return { ok: false, error: r.error || `HTTP ${r.status}`, campaigns: [] };
  return {
    ok: true,
    claimable: r.data.claimable === true,
    campaigns: Array.isArray(r.data.campaigns) ? r.data.campaigns : [],
  };
}

/**
 * 只读地判断「今天签到了没」——**不领取任何东西**。
 *
 * 关键前提：/campaigns 是 GET 且只读（`checkin()` 才 POST claim），所以
 * 拿它查状态不会把「未签到」变成「已签到」。这是与 TRAE 的 status() 同一个
 * 定位（那边也是只读接口），界面要显示的正是这个。
 *
 * 判定口径（实测）：
 *   claimStatus = 'CLAIMABLE' → 还没领（今天可签）
 *   claimStatus = 'CLAIMED'   → 已领（今天已签）
 *   一个活动都没有          → 查不出，给 null（不猜成已签）
 *
 * 顺带把「下次可签时刻」算出来：活动的 endAt（Unix 秒）就是刷新时刻——
 * 官方活动描述写着 Daily reset: 10:00 (UTC+8)，与本项目记载一致，
 * 不是 00:00。查不到时返回 null，界面显示「—」而不是编一个。
 */
async function checkinStatus(token, region) {
  const list = await listCampaigns(token, region);
  if (!list.ok) return { ok: false, error: list.error, checkedIn: null, nextAt: null, pending: null };

  const camps = list.campaigns || [];
  if (!camps.length) {
    // 上游没给任何活动：既不能说已签也不能说未签，如实 null
    return { ok: true, checkedIn: null, nextAt: null, pending: null, campaigns: 0 };
  }

  const claimable = camps.filter((c) => c.claimStatus === 'CLAIMABLE');
  const claimed = camps.filter((c) => c.claimStatus === 'CLAIMED');

  // 待领总额：只有 CLAIMABLE 的才算「今天还没领」
  const pending = claimable.reduce(
    (s, c) => s + ((c.benefit && typeof c.benefit.amount === 'number') ? c.benefit.amount : 0), 0);

  // 下次可签时刻：取活动最早的 endAt（今天这批的截止 = 明天这批的开始）
  const ends = camps.map((c) => (typeof c.endAt === 'number' ? c.endAt : 0)).filter((n) => n > 0);
  const nextAt = ends.length ? Math.min(...ends) * 1000 : null;

  return {
    ok: true,
    checkedIn: claimable.length === 0 && claimed.length > 0,
    // 有可领的 → 明确「未签」；一个活动都没 → null
    pending: claimable.length ? Number(pending.toFixed(4)) : (claimed.length ? 0 : null),
    nextAt,
    campaigns: camps.length,
    claimable: claimable.length,
    claimed: claimed.length,
  };
}

async function claimCampaign(token, region, campaignId) {
  const ep = c.endpointsOf(region);
  const url = `${ep.CampaignsBase}/${encodeURIComponent(campaignId)}/claim`;
  const r = await request(url, {
    method: 'POST',
    headers: bearerHeaders(token, { 'cosy-clienttype': c.CHECKIN_CLIENT_TYPE }),
    body: {},
  });
  if (r.status !== 200 || !r.data) return { ok: false, error: r.error || `HTTP ${r.status}`, raw: r.raw };
  const d = r.data;
  // **领取响应里带到期信息**（benefit.validity），这是「这批积分什么时候作废」
  // 的唯一权威来源——Qoder 没有逐批余额接口（实测 /quota/detail 等一律 503）。
  // 所以要原样带出来落盘，否则过期信息永久丢失。
  const validity = (d.benefit && d.benefit.validity) || {};
  return {
    ok: true,
    status: d.status || '',
    benefit: d.benefit || null,
    replayed: d.replayed === true,
    // grantedAt 是服务端给的领取时刻（ISO）；缺失时由调用方用本地时间兜底
    grantedAt: d.grantedAt || '',
    // 有效期：mode=RELATIVE_DAYS + days=30 是最常见形态
    validityMode: validity.mode || '',
    validityDays: typeof validity.days === 'number' ? validity.days : null,
    amount: (d.benefit && typeof d.benefit.amount === 'number') ? d.benefit.amount : null,
    modelScope: (d.benefit && d.benefit.modelScope) || null,
  };
}

/**
 * 签到一次（查列表 + 领所有可领的）。返回领取明细。
 * 领之前/之后各读一次额度，报出**实际到账差值**——与 TRAE 同一约定：
 * 上游从不直接告诉你发了多少，只看总额会把「没生效」误读成成功。
 *
 * @param {object} [opts.account] 账号对象。给了就顺手把每个批次写进本地账本
 *   （src/qoder/grants.js）——**过期提醒靠它**，因为上游没有逐批余额接口。
 */
async function checkin(token, region, opts = {}) {
  const before = await fetchQuota(token, region);
  const list = await listCampaigns(token, region);
  if (!list.ok) return { ok: false, error: list.error, claimed: [] };
  const claimed = [];
  for (const camp of list.campaigns) {
    if (camp.claimStatus !== 'CLAIMABLE') continue;
    const r = await claimCampaign(token, region, camp.campaignId);
    claimed.push({
      campaignId: camp.campaignId,
      key: camp.campaignKey || '',
      amount: (r.amount != null ? r.amount : (camp.benefit && camp.benefit.amount)),
      ok: r.ok,
      status: r.status || '',
      error: r.error || '',
      // 到期信息：领取响应里才有（上游唯一的权威来源）
      grantedAt: r.grantedAt || '',
      validityMode: r.validityMode || '',
      validityDays: r.validityDays,
    });
    // 落本地账本：过期提醒的数据源。写失败不影响签到结果本身。
    if (r.ok && opts.account) {
      try {
        const grants = require('./grants');
        grants.record(grants.fromClaim(r, opts.account));
      } catch (e) { /* 记账失败不影响签到 */ }
    }
  }
  // 结算有延迟，等一拍再读
  if (claimed.some((x) => x.ok)) await new Promise((s) => setTimeout(s, 1500));
  const after = await fetchQuota(token, region);
  // 到账差值：以 addOnQuota 为准（免费用户的积分都进这里）
  let gained = null;
  if (before.ok && after.ok && before.addOnQuota && after.addOnQuota) {
    gained = Number((after.addOnQuota.remaining - before.addOnQuota.remaining).toFixed(4));
  }
  return {
    ok: true,
    claimed,
    gained,
    before: before.ok ? before.addOnQuota : null,
    after: after.ok ? after.addOnQuota : null,
    // 一个活动都没领到（今天已签过）不是错误，如实报出
    alreadyChecked: claimed.filter((x) => x.ok).length === 0 && !list.claimable,
  };
}

module.exports = {
  request, bearerHeaders, exchange, ensureAccount, fetchUserInfo, fetchPlan,
  fetchQuota, fetchModels, listCampaigns, claimCampaign, checkin, checkinStatus, TIMEOUT_MS,
};
