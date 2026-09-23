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
const constants = require('./constants');
const credentials = require('./credentials');

const SITE_ORIGIN = 'https://qwenwork.cn';
const WALLETS_PATH = '/user/wallets';

/** 每日免费额度上限。接口不给，只能配置。0 表示不显示分母 */
function dailyLimit() {
  const n = Number(process.env.DUMATE_QWENWORK_DAILY_CREDITS);
  return Number.isFinite(n) && n > 0 ? n : 100;
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
  out.limit = dailyLimit();
  out.freeUsed = Math.max(0, out.limit - out.daily);
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
      model: opts.model || '',
      ms: opts.startedAt ? Date.now() - opts.startedAt : null,
      free: Number(free.toFixed(6)),
      paid: Number(paid.toFixed(6)),
      total: Number((free + paid).toFixed(6)),
      pool,
      balance: { daily: after.daily, monthly: after.monthly, longterm: after.longterm },
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

/** 读归因历史（供管理端按天聚合） */
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
  fetchWallets, capture, primeBaseline, readHistory, record,
  dailyLimit, SITE_ORIGIN, WALLETS_PATH,
};
