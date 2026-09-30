// src/qwenwork/credits.js - 千问办公积分：余额读取 + 按请求归因
//
// 积分不在凭证里，要问站点：GET https://qwenwork.cn/user/wallets
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
//
// **三处状态都按账号隔离**（账号池化之后）：余额缓存、归因基准、串行队列。
// 混在一起会算出「A 请求扣了 B 账号的钱」——多账号下这是最要紧的一条。
const https = require('https');
const fs = require('fs');
const path = require('path');
const constants = require('./constants');

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
//
// 峰值是**账号级**的：两个账号的每日额度互不相干，混在一个桶里会
// 把 A 的峰值当成 B 的上限。文件按账号 id 分桶。
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

/**
 * 读峰值文件。两种形状都接受：
 *   {'2026-09-25': 81.13}              ← 单账号时期的旧格式
 *   {'1': {'2026-09-25': 81.13}, ...}  ← 按账号分桶
 *
 * 旧格式归到账号 0（历史数据确实是单账号，归属明确）。这样升级后
 * 老用户的「今日已用」不会凭空归零。
 */
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

/** 取某账号的 {day: peak} 桶。旧格式里非对象的值视作账号 0 的桶 */
function peakBucketOf(root, accountKey) {
  const cur = root[accountKey];
  if (cur && typeof cur === 'object') return cur;
  return null;
}

/**
 * 记录本次观测，返回今日消耗的真实口径。
 * @param {number} balance 该账号当前每日额度余额
 * @param {string} accountKey 账号 id（字符串）
 * @returns {{limit:number, limitSource:string, freeUsed:number, peak:number, calibrated:boolean}}
 */
function dailyUsageFromBalance(balance, accountKey) {
  const k = dayKey();
  const accKey = String(accountKey == null ? 0 : accountKey);
  const st = readPeak();
  let bucket = peakBucketOf(st, accKey);
  if (!bucket) {
    bucket = {};
    st[accKey] = bucket;
  }
  const prev = bucket[k] || 0;
  const peak = Math.max(prev, balance || 0);
  if (peak !== prev) {
    bucket[k] = Number(peak.toFixed(4));
    // 只保留最近 30 天，避免文件无限增长
    const keys = Object.keys(bucket).sort();
    while (keys.length > 30) delete bucket[keys.shift()];
    writePeak(st);
  }
  // 上限：配置值兜底 + 观测峰值，取较大者
  const configured = dailyLimit();
  const limit = Math.max(configured || 0, peak);
  // calibrated=true 表示峰值已经追平或超过配置值（说明已观测到接近满额的状态）
  const calibrated = peak >= (configured || 0);
  // 今日消耗 = 上限 − 余额。**但未校准时这个差值不可信**：
  // limit 此时是配置兜底（100），若余额为 0（账号欠费 / 额度被扣穿），
  // 差值会算出「今日已用 100」——而真相是「没观测到满额，推不出消耗」。
  // 实测账号 示例账号 就是这样：一次请求都没走，却报已用 100。
  // 所以未校准一律给 null，界面显示 — 并注明无法推算，而不是编一个数。
  const freeUsed = calibrated
    ? Math.max(0, Number((limit - (balance || 0)).toFixed(4)))
    : null;
  return {
    limit,
    limitSource: calibrated ? 'observed' : 'config-lower-bound',
    freeUsed,
    peak: Number(peak.toFixed(4)),
    calibrated,
  };
}

// 余额缓存按账号分开：A 的余额不能回答「B 还剩多少」
const CACHE_MS = parseInt(process.env.DUMATE_QWENWORK_CREDIT_CACHE_MS || '30000', 10);
const caches = new Map();

/** 取 token。兼容 account 对象与裸 token 串 */
function tokenOf(account) {
  if (!account) return '';
  if (typeof account === 'string') return account;
  return account.accessToken || account.token || '';
}

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

/**
 * 读三池余额。默认走 30s 缓存——仪表盘刷新不该每次都打上游。
 *
 * @param {object} [opts]
 * @param {object|string} [opts.account] 账号对象或裸 token。**必填**：余额是
 *   账号级的，没有账号就不知道该查谁。
 * @param {boolean} [opts.force] 跳过缓存
 */
async function fetchWallets(opts = {}) {
  const token = tokenOf(opts.account);
  if (!token) {
    return { ok: false, error: '缺少账号 token，无法查询余额', daily: null, monthly: null, longterm: null };
  }
  // 无账号对象（裸 token）时按 token 尾段分桶，保证缓存仍然按身份隔离
  const key = String((opts.account && opts.account.id) || token.slice(-8));
  if (!opts.force) {
    const hit = caches.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }

  let r = await httpGet(WALLETS_PATH, token);
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: r.error || `HTTP ${r.status}`, daily: null, monthly: null, longterm: null };
  }

  // 「三池全 0 + active_wallets 空」要**重试一次**再下结论。
  //
  // 为什么不能直接当成「用完了」：实测（2026-09-30）同一时刻打两个接口，
  // `/user/wallets` 报全 0 而 `account-context` 的 quota.remaining 报 100——
  // 两者矛盾，说明那次是**读失败**（上游/边缘节点的一次瞬时状态）。
  // 而界面把 0 读成「今天用光了」，于是用户以为「每天得用一下才刷新」。
  //
  // 为什么也不能一律当成读失败：真·额度耗尽时三池确实都是 0，那种情况
  // 显示 0 是**正确的**。历史归因里没有全 0 记录只是因为还没遇到过真的耗尽
  // （95 条 daily=0 都伴随付费池 >0，即免费扣完转扣付费）。
  //
  // 所以用重试来区分：瞬时抖动重试即恢复；真实归零重试仍是 0，如实上报。
  const allZero = (x) => {
    const dd = x && x.data && x.data.data;
    if (!dd) return false;
    const w = (dd.active_wallets && Array.isArray(dd.active_wallets.wallets)) ? dd.active_wallets.wallets : [];
    return num((dd.daily_credits || {}).total_balance) === 0
      && num((dd.monthly_credits || {}).total_balance) === 0
      && num((dd.longterm_credits || {}).total_balance) === 0
      && w.length === 0;
  };
  let retried = false;     // 是否发生了重试
  let retryRecovered = false; // 重试后拿到了非 0（即第一次是抖动）
  if (allZero(r)) {
    retried = true;
    await new Promise((s) => setTimeout(s, 400));
    const r2 = await httpGet(WALLETS_PATH, token);
    if (r2.status === 200 && r2.data && !allZero(r2)) {
      // 重试拿到了非 0 —— 第一次确实是抖动，用第二次的结果
      r = r2;
      retryRecovered = true;
    }
    // 重试仍是全 0（或重试失败）：落回下面的正常路径，如实上报 0。
    // 此时无法区分「真耗尽」与「持续抖动」，报 0 是保守且诚实的选择。
  }

  const d = r.data.data || {};
  const wallets = (d.active_wallets && Array.isArray(d.active_wallets.wallets))
    ? d.active_wallets.wallets : [];
  const out = {
    ok: true,
    daily: num((d.daily_credits || {}).total_balance),
    monthly: num((d.monthly_credits || {}).total_balance),
    longterm: num((d.longterm_credits || {}).total_balance),
    // 只有「重试过且仍是全 0」才标出来——那才是值得排查的状态
    // （可能真耗尽，也可能上游持续异常）。抖动后恢复的不算异常，不标。
    ...(retried && !retryRecovered ? { retried: true } : {}),
    // 最近到期的钱包。**注意这不是「积分要作废」**：daily 池每天 00:00 重置，
    // 所以 valid_to 就是明天的重置时刻——它每天都「即将到期」，不是风险。
    // 真正会作废的是 expiring_soon 那段（付费积分按有效期，过期即消失），
    // 两者语义不同，界面上必须分开说，否则会天天误报「积分要过期了」。
    expiring: wallets.slice(0, 5).map((w) => ({
      balance: num(w.balance),
      valid_to: String(w.valid_to || ''),
      // 标注来源：reset = 每日额度重置（不是损失），expire = 真要作废
      kind: 'reset',
    })),
    // 上游自己给的「即将过期」列表——这才是会作废的那部分。
    // count/total_balance 为 0 时是空数组，界面据此判断「有无风险」。
    expiringSoon: (() => {
      const es = d.expiring_soon || {};
      const ws = Array.isArray(es.wallets) ? es.wallets : [];
      return {
        count: num(es.count),
        total: num(es.total_balance),
        wallets: ws.map((w) => ({
          balance: num(w.balance),
          valid_to: String(w.valid_to || ''),
        })),
      };
    })(),
    fetchedAt: Date.now(),
  };
  out.total = out.daily + out.monthly + out.longterm;
  out.paid = out.monthly + out.longterm;
  // 今日真实消耗：上限由「观测峰值 + 配置兜底」得出（见 dailyUsageFromBalance），
  // 余额是接口的真实值，两者相减即当天全部消耗——包含不经网关的对话。
  const u = dailyUsageFromBalance(out.daily, (opts.account && opts.account.id));
  out.limit = u.limit;
  out.limitSource = u.limitSource;
  out.freeUsed = u.freeUsed;
  out.peak = u.peak;
  out.calibrated = u.calibrated;
  caches.set(key, { at: Date.now(), data: out });
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
//
// **基准与队列都按账号分开**（src/traework/credits.js 的 queues 同款）：
// 共用一个基准会把 A 的余额当成 B 的起点，于是第一条跨账号的差值
// 等于两个账号余额之差——一个完全编出来的数。
// ---------------------------------------------------------------------------
const queues = new Map();   // 账号 id → Promise（串行队列）
const baselines = new Map(); // 账号 id → 上一次结算后的余额

/** 账号在队列里的 key。没有 id 就退回 token 尾段，保证同一身份同一条队列 */
function queueKeyOf(account) {
  return String((account && account.id) || tokenOf(account).slice(-8) || 'unknown');
}

/**
 * 采集一次请求的积分消耗。**必须在请求完成之后调用**——请求本身要几秒
 * （实测 4s），若在发出前调用，等待 1.2s 就读余额会读到请求还没结算的状态。
 *
 * @param {object} opts
 * @param {object} opts.account  本次实际使用的账号（**必填**：余额与基准都是账号级的）
 * @param {string} opts.model   模型名，写进归因记录
 * @param {number} opts.startedAt 请求开始时刻
 * @param {string} [opts.reqId] 请求埋点的 req_id。**两边靠它对齐**——
 *   归因要等 1.5s 结算，时间戳对不上；不带这个键就只能靠时间猜，
 *   同一秒内两条请求会互相串账。
 * @returns {Promise<{free:number, paid:number, pool:string}|null>}
 */
function capture(opts = {}) {
  const account = opts.account;
  if (!account) return Promise.resolve(null);
  const key = queueKeyOf(account);
  const run = async () => {
    // 首次没有基准，只建立它，不产出归因（否则会把历史消耗算到这次请求上）
    if (!baselines.has(key)) {
      const w = await fetchWallets({ account, force: true });
      if (!w.ok) return null;
      baselines.set(key, { daily: w.daily, monthly: w.monthly, longterm: w.longterm });
      return null;
    }
    const before = baselines.get(key);
    // 等结算。实测延迟 < 1s，留 1.5s 余量
    await new Promise((s) => setTimeout(s, 1500));
    const after = await fetchWallets({ account, force: true });
    if (!after.ok) return null;
    baselines.set(key, { daily: after.daily, monthly: after.monthly, longterm: after.longterm });

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
      // 扣的是哪个千问账号。多账号下「哪个账号花了多少」正是这条通道最要紧的
      // 信息。
      //
      // **account 保持对象形状**：前端（web/src/api/reqlogs.ts 的 qw_account
      // 与 ReqLogsView 的 .name / .tier）按 {id,name,tier,planId} 渲染，改成
      // 字符串会让那些格子直接空白。所以只**新增** account_id，不换形状。
      account_id: account.id != null ? account.id : null,
      account: {
        id: String(account.id != null ? account.id : ''),
        name: account.nickname || account.username || '',
        tier: account.tier || '',
        planId: account.planId || '',
      },
    };
    // 并发时「前后差值」分不清是谁消耗的——总和正确、单项归属不准。
    // 如实标记而不是假装精确，聚合时可按需排除。
    if (opts.concurrent) entry.concurrent = true;
    record(entry);
    return entry;
  };
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  queues.set(key, next.catch(() => {}));
  return next;
}

/**
 * 主动建立基准（管理端刷新时用，避免第一次请求归因不出结果）。
 * 按账号逐个建——池里有几个账号就要几个基准。
 */
async function primeBaseline(accounts) {
  const list = Array.isArray(accounts) ? accounts : (accounts ? [accounts] : []);
  const out = [];
  for (const a of list) {
    if (!a) continue;
    const w = await fetchWallets({ account: a, force: true });
    if (w.ok) {
      baselines.set(queueKeyOf(a), { daily: w.daily, monthly: w.monthly, longterm: w.longterm });
      out.push({ id: a.id, ok: true });
    } else {
      out.push({ id: a.id, ok: false, error: w.error });
    }
  }
  return out;
}

/** 丢掉某账号的基准与队列（删除账号时调用，避免 Map 泄漏） */
function forget(account) {
  if (!account) return;
  const key = queueKeyOf(account);
  baselines.delete(key);
  queues.delete(key);
  caches.delete(String(account.id || ''));
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
  fetchWallets, capture, primeBaseline, forget, readHistory, indexByReqId, record,
  dailyLimit, SITE_ORIGIN, WALLETS_PATH,
};
