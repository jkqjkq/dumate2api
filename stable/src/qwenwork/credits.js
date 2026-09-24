// src/qwenwork/credits.js - 千问办公积分：余额读取 + 按请求归因
//
// 积分不在 auth-v2.dat 里，要问站点：GET https://qwenwork.cn/user/wallets
// （同一个 Bearer token 可用）。返回三个独立池子：
//
//   daily_credits     免费，每天 00:00 (+08:00) 重置
//   monthly_credits   订阅套餐内 → 付费
//   longterm_credits  充值/赠送 → 付费
//
// 归因方法：请求前后各读一次余额，**哪个池减少就是消耗的哪种**。
// 实测结算延迟 < 1 秒，所以响应发出后等一小会儿再读即可。
//
// 一个必须诚实的地方：接口只返回**余额**，不返回「每日上限」。
// 「今日已用 = 上限 − 余额」里的上限来自配置（默认 100），不是接口给的，
// 界面上必须标注来源，否则额度政策一变就没人知道数字是错的。
const https = require('https');
const fs = require('fs');
const path = require('path');
const constants = require('./constants');
const credentials = require('./credentials');

const SITE_ORIGIN = 'https://qwenwork.cn';
const WALLETS_PATH = '/user/wallets';

// ---------------------------------------------------------------------------
// 每日额度上限的推断
//
// 接口只给余额、不给上限（实测 /user/wallets 的 data 里没有 limit/quota
// 字段）。但「今日消耗 = 上限 − 余额」是用户真正想看的数，所以这里用
// **观测峰值**推断：每日额度每天 00:00 重置到上限、之后只减不增，
// 因此当天观测到的最大值就是最接近上限的真实值。
//
// 峰值法有两个已知弱点，都在返回值里如实标注：
//   1. 首次观测若在当天中途（本例 81.13），峰值就是偏小的，推断值会小于
//      真实消耗——要等次日重置后才能校准到 100
//   2. 若当天有过补充（充值/赠送），余额会回升，峰值反而偏大
// 所以额外接受配置值作兜底：取「配置值」与「观测峰值」的较大者，
// 并把来源标出来，让用户知道这个数是怎么来的。
// ---------------------------------------------------------------------------
const PEAK_FILE = 'qwenwork-daypeak.json';

/** 每日免费额度的配置上限。接口不给，作为峰值的兜底下界。0 = 不设兜底 */
function dailyLimit() {
  const n = Number(process.env.DUMATE_QWENWORK_DAILY_CREDITS);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function peakPath() {
  return path.join(dataDir(), PEAK_FILE);
}

function dayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readPeak() {
  try { return JSON.parse(fs.readFileSync(peakPath(), 'utf8')); } catch (e) { return {}; }
}

function writePeak(o) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = peakPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o));
    fs.renameSync(tmp, peakPath());
  } catch (e) { /* 峰值写不进不影响主流程 */ }
}

/**
 * 记录本次观测，返回今日消耗的真实口径。
 * @returns {{limit:number, limitSource:string, freeUsed:number, peak:number, calibrated:boolean}}
 */
function dailyUsageFromBalance(balance) {
  const k = dayKey();
  const st = readPeak();
  const prev = st[k] || 0;
  const peak = Math.max(prev, balance || 0);
  if (peak !== prev) {
    st[k] = Number(peak.toFixed(4));
    // 只保留最近 30 天，避免文件无限增长
    const keys = Object.keys(st).sort();
    while (keys.length > 30) delete st[keys.shift()];
    writePeak(st);
  }
  // 上限：配置值兜底 + 观测峰值，取较大者
  const configured = dailyLimit();
  const limit = Math.max(configured || 0, peak);
  // calibrated=true 表示峰值已经追平或超过配置值（说明已观测到接近满额的状态）
  const calibrated = peak >= (configured || 0);
  return {
    limit,
    limitSource: calibrated ? 'observed' : 'config-lower-bound',
    freeUsed: Math.max(0, Number((limit - (balance || 0)).toFixed(4))),
    peak: Number(peak.toFixed(4)),
    calibrated,
  };
}

const CACHE_MS = parseInt(process.env.DUMATE_QWENWORK_CREDIT_CACHE_MS || '30000', 10);
let cache = { at: 0, data: null };

function httpGet(path, token, timeout = 15000) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'qwenwork.cn',
      path,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': constants.USER_AGENT,
      },
      timeout,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch (e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 读三池余额。默认走 30s 缓存——仪表盘刷新不该每次都打上游 */
async function fetchWallets({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const doc = credentials.decryptAuth();
  const r = await httpGet(WALLETS_PATH, doc.token);
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: r.error || `HTTP ${r.status}`, daily: null, monthly: null, longterm: null };
  }
  const d = r.data.data || {};
  const wallets = (d.active_wallets && Array.isArray(d.active_wallets.wallets))
    ? d.active_wallets.wallets : [];
  const out = {
    ok: true,
    daily: num((d.daily_credits || {}).total_balance),
    monthly: num((d.monthly_credits || {}).total_balance),
    longterm: num((d.longterm_credits || {}).total_balance),
    // 最近到期的钱包（免费额度每天重置，这里能看到 valid_to）
    expiring: wallets.slice(0, 5).map((w) => ({
      balance: num(w.balance),
      valid_to: String(w.valid_to || ''),
    })),
    fetchedAt: Date.now(),
  };
  out.total = out.daily + out.monthly + out.longterm;
  out.paid = out.monthly + out.longterm;
  // 今日真实消耗：上限由「观测峰值 + 配置兜底」得出（见 dailyUsageFromBalance），
  // 余额是接口的真实值，两者相减即当天全部消耗——包含不经网关的对话。
  const u = dailyUsageFromBalance(out.daily);
  out.limit = u.limit;
  out.limitSource = u.limitSource;
  out.freeUsed = u.freeUsed;
  out.peak = u.peak;
  out.calibrated = u.calibrated;
  cache = { at: Date.now(), data: out };
  return out;
}

// ---------------------------------------------------------------------------
// 按请求归因
//
// 三个必须串行的理由，缺一个都会算错：
//   1. 并发请求下「前后差值」会互相穿插——A 的 after 可能已包含 B 的扣费
//   2. 「请求前余额」也必须在队列内读。若在队列外读，B 可能拿到 A 扣费前的
//      旧值，于是 B 的差值把 A 的消耗也算进去，重复计一次
//   3. 结算有延迟（实测 < 1s），after 要等一拍再读
//
// 所以这里维护一个「上一次结算后的余额」作为基准，每次采集完更新它。
// 与 points-cursor.js 同一思路（那里也是宁可排队也不缺档）。
// ---------------------------------------------------------------------------
let queue = Promise.resolve();
let baseline = null; // 上一次结算后的余额；null = 还没建立基准

/**
 * 采集一次请求的积分消耗。**必须在请求完成之后调用**——请求本身要几秒
 * （实测 4s），若在发出前调用，等待 1.2s 就读余额会读到请求还没结算的状态。
 *
 * @param {object} opts
 * @param {string} opts.model   模型名，写进归因记录
 * @param {number} opts.startedAt 请求开始时刻
 * @param {string} [opts.reqId] 请求埋点的 req_id。**两边靠它对齐**——
 *   归因要等 1.5s 结算，时间戳对不上；不带这个键就只能靠时间猜，
 *   同一秒内两条请求会互相串账。
 * @returns {Promise<{free:number, paid:number, pool:string}|null>}
 */
function capture(opts = {}) {
  const run = async () => {
    // 首次没有基准，只建立它，不产出归因（否则会把历史消耗算到这次请求上）
    if (!baseline) {
      const w = await fetchWallets({ force: true });
      if (!w.ok) return null;
      baseline = { daily: w.daily, monthly: w.monthly, longterm: w.longterm };
      return null;
    }
    const before = baseline;
    // 等结算。实测延迟 < 1s，留 1.5s 余量
    await new Promise((s) => setTimeout(s, 1500));
    const after = await fetchWallets({ force: true });
    if (!after.ok) return null;
    baseline = { daily: after.daily, monthly: after.monthly, longterm: after.longterm };

    const free = Math.max(0, num(before.daily) - num(after.daily));
    const paid = Math.max(0, (num(before.monthly) + num(before.longterm))
      - (num(after.monthly) + num(after.longterm)));
    // 哪个池减少就是消耗的哪种；实测顺序是先用免费额度
    const pool = free > 0 ? 'daily' : (paid > 0 ? 'paid' : 'none');
    const entry = {
      ts: Date.now(),
      // req_id：与请求埋点（requests.jsonl）的同一字段对齐。
      // 归因要等 1.5s 结算，ts 必然晚于埋点；只有这个键能精确配对。
      req_id: opts.reqId || '',
      model: opts.model || '',
      ms: opts.startedAt ? Date.now() - opts.startedAt : null,
      free: Number(free.toFixed(6)),
      paid: Number(paid.toFixed(6)),
      total: Number((free + paid).toFixed(6)),
      pool,
      balance: { daily: after.daily, monthly: after.monthly, longterm: after.longterm },
      // 扣的是哪个千问账号。千问是单账号直连（不像搭子有账号池），
      // 入口 token 来源唯一，记录一次足够；多账号场景以后再说。
      // 由 caller 在调用 capture 前解好传入，避免在这里 require 凭证模块
      // 撞上 DPAPI 初始化时序
      account: opts.account || null,
    };
    // 并发时「前后差值」分不清是谁消耗的——总和正确、单项归属不准。
    // 如实标记而不是假装精确，聚合时可按需排除。
    if (opts.concurrent) entry.concurrent = true;
    record(entry);
    return entry;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** 主动建立基准（管理端刷新时用，避免第一次请求归因不出结果） */
async function primeBaseline() {
  const w = await fetchWallets({ force: true });
  if (w.ok) baseline = { daily: w.daily, monthly: w.monthly, longterm: w.longterm };
  return baseline;
}

/** 读归因历史（供管理端按天聚合）。rows 已带 req_id，可按请求精确关联 */
function readHistory(limit = 0) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(
    process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data'),
    'qwenwork-credits.jsonl'
  );
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for (const l of lines) {
      try { rows.push(JSON.parse(l)); } catch (e) { /* 跳过坏行 */ }
    }
    return limit > 0 ? rows.slice(-limit) : rows;
  } catch (e) {
    return [];
  }
}

/**
 * 按 req_id 建索引，供请求日志按条附上积分消耗。
 * 用「最后一条同 id 的记录」——重试或重复采集时以最新为准。
 */
function indexByReqId() {
  const map = new Map();
  for (const r of readHistory()) {
    if (r && r.req_id) map.set(r.req_id, r);
  }
  return map;
}

function record(entry) {
  const fs = require('fs');
  const path = require('path');
  const dir = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'qwenwork-credits.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (e) { /* 埋点失败绝不影响正在转发的响应 */ }
}

module.exports = {
  fetchWallets, capture, primeBaseline, readHistory, indexByReqId, record,
  dailyLimit, SITE_ORIGIN, WALLETS_PATH,
};
