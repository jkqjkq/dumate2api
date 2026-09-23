// src/points-cursor.js - 单请求积分成本（余额游标差）
//
// 为什么不能直接拿上游账单归因：上游 usage 记录只有 createdAt（秒级）与
// pointsChange，实测同一请求的时间窗内会有 1~3 条候选扣费，无法唯一对应
// （同一个 -0.10 会被两条请求各自认领）。硬挑一条等于编数字。
//
// 可靠做法：每条请求结束后记一次余额，相邻两次的差值 = 后一条请求的成本。
// 采集放在响应发出之后异步做，不占请求延迟。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const FILE = 'points-cursor.jsonl';
const ENABLED = process.env.DUMATE_POINTS_METER !== '0';

// 每个账号一条串行队列。不能用「超过 N 条就丢弃」来限流：丢一条游标会让
// 下一条请求的差值跨过两条请求，静默算错。宁可排队慢一点，也不能缺档。
const queues = new Map();

function append(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, FILE), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (e) { /* 埋点失败绝不能影响转发 */ }
}

// 桌面链路：8980 后端的 quota_overview 是唯一权威余额口径
function balanceDesktop() {
  return new Promise((resolve) => {
    let discovery;
    try { discovery = require('./discovery'); } catch (e) { return resolve(null); }
    discovery.discoverPort().then((port) => {
      if (!port) return resolve(null);
      const req = require('http').request(
        { host: '127.0.0.1', port, path: '/api/dumate/points/quota_overview', method: 'GET', timeout: 8000 },
        (res) => {
          let d = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { d += c; });
          res.on('end', () => {
            try {
              const j = JSON.parse(d);
              const r = j.result || j;
              resolve(Number(r.totalPoints || 0) - Number(r.usedPoints || 0));
            } catch (e) { resolve(null); }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    }).catch(() => resolve(null));
  });
}

// 网页凭证链路：按账号 cookie 查自己的余额
async function balanceWeb(accountName) {
  try {
    const accounts = require('./accounts');
    const web = require('./dumate-web');
    const a = accounts.load().accounts.find((x) => x.name === accountName || x.nickname === accountName);
    if (!a || !a.cookie) return null;
    const r = await web.api.quotaOverview(a.cookie);
    return r.ok ? r.left : null;
  } catch (e) { return null; }
}

async function capture(ts, account) {
  if (!ENABLED) return;
  const key = account || '';
  // 串行：同一账号的游标必须按请求结束顺序落盘，否则差值会配错
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      const balance = account ? await balanceWeb(account) : await balanceDesktop();
      if (typeof balance === 'number' && Number.isFinite(balance)) {
        append({ ts, account: key, balance, at: Date.now() });
      }
    } catch (e) { /* 忽略 */ }
  });
  queues.set(key, next);
  return next;
}

function read() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, FILE), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

// 给 reqlog 行补上本次实际扣费。
// 差值是「上一条请求结束时的余额」减「这条结束时的余额」，所以第一条没有值
// （没有参照点），如实留空而不是补 0。
//
// pageRows 是当前要展示的行，allRows 是同账号的全量行（判定并发必须看全量：
// 只看当前页会漏掉与页外请求的重叠，把不准的差值标成准确）。
function attachCosts(pageRows, allRows) {
  const cursor = read();
  if (!cursor.length) return pageRows;
  const all = allRows && allRows.length ? allRows : pageRows;

  const byAcc = {};
  for (const c of cursor) {
    const k = c.account || '';
    (byAcc[k] = byAcc[k] || []).push(c);
  }
  for (const k of Object.keys(byAcc)) byAcc[k].sort((a, b) => a.ts - b.ts);

  const delta = {};
  for (const k of Object.keys(byAcc)) {
    const list = byAcc[k];
    for (let i = 1; i < list.length; i++) {
      delta[list[i].ts] = Math.round((list[i - 1].balance - list[i].balance) * 100) / 100;
    }
  }

  // 并发判定：请求 A 与 B 的执行区间有交集时，余额差会把 B 早段
  // （A 结束前）的消耗算进 A、把 A 的算进 B，两条都不准。
  // 判据是区间相交，不是「谁先结束」。
  const byAccRows = {};
  for (const r of all) {
    const k = r.account || '';
    (byAccRows[k] = byAccRows[k] || []).push(r);
  }
  const inexact = new Set();
  for (const k of Object.keys(byAccRows)) {
    const list = byAccRows[k].slice().sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < list.length; i++) {
      const aStart = list[i].ts - (list[i].ms || 0);
      for (let j = i + 1; j < list.length; j++) {
        // 已按结束时间排序，后面请求的结束只会更晚；若它的开始早于
        // 前一条的结束，则两者重叠
        if (list[j].ts - (list[j].ms || 0) < list[i].ts) {
          inexact.add(list[i].ts);
          inexact.add(list[j].ts);
        } else {
          break;
        }
      }
    }
  }

  return pageRows.map((r) => {
    if (!(r.ts in delta)) return r;
    return { ...r, points_delta: delta[r.ts], points_exact: !inexact.has(r.ts) };
  });
}

module.exports = { capture, read, attachCosts, FILE };
