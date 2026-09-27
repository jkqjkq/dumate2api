// src/traework/credits.js - TRAE Work 逐请求积分归因（按账号的消耗游标）
//
// 为什么不能直接用上游账单归因：ide_user_ent_usage 只给**累计值**
// （usage_summary.consumed_amount），没有逐笔流水，拿不到「这一条请求花了多少」。
//
// 做法与 points-cursor.js 同构：每条请求结束后记一次该账号的累计已消耗，
// 同一账号相邻两次的差值 = 后一条请求的成本。三个理由缺一不可：
//   1. **必须用 consumed 而不是 remain**：remain 会因签到 / 充值回升，
//      差值会算出负数；consumed 单调不减，只会被消耗推高。
//   2. **每账号一条串行队列**：丢一条游标会让下一条的差值跨过两条请求，
//      静默算错——宁可排队也不缺档。
//   3. **采集在响应发出之后**：请求本身要几秒，提前读会读到还没结算的状态。
//
// TRAE 与千问的关键差别：**它是多账号**（凭证自持），所以游标必须按账号分开，
// 且归因记录要带上账号——「哪个账号花了多少」正是这个通道最要紧的信息。
const fs = require('fs');
const path = require('path');
const checkin = require('./checkin');

const FILE = 'traework-credits.jsonl';

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

function append(entry) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(filePath(), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (e) { /* 埋点失败绝不影响正在转发的响应 */ }
}

// 每账号一条串行队列，key 是账号 id
const queues = new Map();

/**
 * 采集一次请求后的账号消耗游标。**必须在请求完成之后调用**。
 *
 * @param {object} account 本次实际使用的账号（多账号下必须记下来源）
 * @param {object} [opts]
 * @param {string} [opts.reqId] 请求埋点的 req_id。两边靠它精确配对——
 *   归因要等额度接口返回，ts 必然晚于埋点，靠时间猜会串账。
 * @param {string} [opts.model] 模型名
 * @param {number} [opts.startedAt] 请求开始时刻
 * @returns {Promise<object|null>}
 */
function capture(account, opts = {}) {
  if (!account || account.id == null) return Promise.resolve(null);
  const key = String(account.id);
  const run = async () => {
    const u = await checkin.usage(account);
    // 取不到就不落记录。**不补 0**——0 会被读成「这次没花钱」，
    // 而真相是没测到；下一条请求的差值会跨过这一条，界面靠并发/缺档标注体现
    if (!u.ok || u.consumed == null) return null;
    const entry = {
      ts: Date.now(),
      req_id: opts.reqId || '',
      account_id: account.id,
      account: account.nickname || account.uid || `账号 ${account.id}`,
      model: opts.model || '',
      ms: opts.startedAt ? Date.now() - opts.startedAt : null,
      // 累计已消耗：差值算成本靠它（单调不减）
      consumed: u.consumed,
      remain: u.remain,
      limit: u.limit,
    };
    append(entry);
    return entry;
  };
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  queues.set(key, next.catch(() => {}));
  return next;
}

/** 读归因历史 */
function readHistory() {
  try {
    return fs.readFileSync(filePath(), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

/** 按 req_id 建索引，供请求日志按条附上消耗。同 id 取最后一条 */
function indexByReqId() {
  const map = new Map();
  for (const r of readHistory()) {
    if (r && r.req_id) map.set(r.req_id, r);
  }
  return map;
}

/**
 * 给请求日志里 channel=traework 的行附上「真实消耗 + 是哪个账号」。
 *
 * 差值是「同一账号上一条请求的累计已消耗」到「这一条」的增量，所以每个
 * 账号的第一条没有值（没有参照点），如实留空而不是补 0。
 *
 * 并发判定与 points-cursor 同理：两条请求的执行区间有交集时，增量会把
 * 对方的消耗算进来，总和正确、单项不准，标记出来而不是假装精确。
 */
function attachCosts(pageRows) {
  const rows = readHistory();
  if (!rows.length) return pageRows;

  const byAcc = {};
  for (const r of rows) {
    const k = String(r.account_id);
    (byAcc[k] = byAcc[k] || []).push(r);
  }

  const delta = {};
  const inexact = new Set();
  for (const k of Object.keys(byAcc)) {
    const list = byAcc[k].sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < list.length; i++) {
      const d = list[i].consumed - list[i - 1].consumed;
      // 负数说明账号换过 / 上游重置过累计值，这种情况不硬算
      if (Number.isFinite(d) && d >= 0) {
        delta[list[i].req_id] = Math.round(d * 10000) / 10000;
      }
    }
    // 区间相交 = 并发，差值可能含对方的消耗
    for (let i = 0; i < list.length; i++) {
      const aStart = list[i].ts - (list[i].ms || 0);
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].ts - (list[j].ms || 0) < list[i].ts) {
          inexact.add(list[i].req_id);
          inexact.add(list[j].req_id);
        } else break;
      }
    }
  }

  const idx = indexByReqId();
  return pageRows.map((r) => {
    if (r.channel !== 'traework') return r;
    const c = idx.get(r.req_id);
    const out = {
      ...r,
      // 消耗与账号都从归因记录取：账号是**实际使用**的那个，
      // 而不是「当前池里的第一个」——多账号下两者不是一回事
      tw_account: c ? c.account : '',
      tw_consumed: c ? c.consumed : null,
      tw_remain: c ? c.remain : null,
      tw_limit: c ? c.limit : null,
    };
    if (r.req_id in delta) {
      out.tw_cost = delta[r.req_id];
      out.tw_exact = !inexact.has(r.req_id);
    }
    return out;
  });
}

module.exports = { capture, readHistory, indexByReqId, attachCosts, FILE, filePath };
