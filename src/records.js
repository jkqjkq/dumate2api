// src/records.js - 统一的操作记录（签到 / 任务 / 抽奖 / 积分）
//
// 为什么单独建一层：这些动作分散在三个地方——签到状态只存在账号对象里
// （上游返回的 sign_in_days 是「哪天签过」，不是「我什么时候去签的」），
// 任务记录在 task-runs.jsonl，抽奖结果只在抽奖那一刻的响应里。
// 汇总成一个按时间排序的记录流，才能回答「这个账号这几天都发生了什么」。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const FILE = 'activity.jsonl';

function append(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(DATA_DIR, FILE),
      `${JSON.stringify({ ts: Date.now(), ...entry })}\n`,
      'utf8',
    );
  } catch (e) { /* 记录失败不能影响动作本身 */ }
}

// 读记录。返回 { rows, total }，rows 按时间倒序（最新在前）。
// 注意：文件不存在时也要返回同样的形状——早先直接 return []，
// 调用方按 { rows } 解构就会炸（实测 "rows is not iterable"）。
function read(opts = {}) {
  const { limit = 200, account_id = null, type = null, since = null } = opts;
  let rows = [];
  try {
    rows = fs.readFileSync(path.join(DATA_DIR, FILE), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) {
    return { rows: [], total: 0 };
  }

  if (account_id) rows = rows.filter((r) => Number(r.account_id) === Number(account_id));
  if (type) rows = rows.filter((r) => r.type === type);
  if (since) rows = rows.filter((r) => r.ts >= since);

  const total = rows.length;
  rows = rows.reverse();
  return { rows: limit > 0 ? rows.slice(0, limit) : rows, total };
}

// 按账号 + 日期聚合，供日历视图
function dailySummary(days = 30) {
  const since = Date.now() - days * 86400000;
  const { rows } = read({ limit: 0, since });
  const byAccount = {};

  for (const r of rows) {
    const key = r.account_id;
    if (!byAccount[key]) {
      byAccount[key] = { account_id: key, account: r.account || '', days: {}, counts: {} };
    }
    const a = byAccount[key];
    const day = new Date(r.ts).toISOString().slice(0, 10);
    if (!a.days[day]) a.days[day] = {};
    // 同一天同类动作可能多次（如多次抽奖），按类型累加次数
    a.days[day][r.type] = (a.days[day][r.type] || 0) + 1;
    a.counts[r.type] = (a.counts[r.type] || 0) + 1;
  }
  return Object.values(byAccount);
}

module.exports = { append, read, dailySummary, FILE };
