// test/points-agg.test.js - points-agg.js 行为测试（额度包聚合）
//
// 覆盖：normalize 的缺字段兜底与 left 重算（含负值钳 0）、按来源聚合的
// active_days/first_at/last_at/days_since_last、按发放日曲线、expiring 的
// 排序与前 10 截断、expired_unused 判据。时间相关断言用相对时间构造。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aggregate, normalize } = require('../src/points-agg');

const DAY = 86400000;
// 真实数据形态（admin/routes/points.js 的包构造）：granted_at / expire_at
// 一律是毫秒数（startDate * 1000 / expireDate * 1000），不是 ISO 字符串
const ago = (days) => Date.now() - days * DAY;
const ahead = (days) => Date.now() + days * DAY;

test('normalize：缺字段按 0 / null 处理，不抛错', () => {
  const n = normalize({});
  assert.equal(n.total, 0);
  assert.equal(n.used, 0);
  assert.equal(n.left, 0);
  assert.equal(n.granted_at, null);
  assert.equal(n.expire_at, null);
  assert.equal(n.kind, '');
});

test('normalize：left 一律重算为 total-used（不信任上游给的负值）', () => {
  assert.equal(normalize({ total: 100, used: 30, left: 999 }).left, 70);
  assert.equal(normalize({ total: 100, used: 130 }).left, 0, 'used > total 钳到 0');
  // 字符串数字也要能算（上游偶尔给字符串）
  assert.equal(normalize({ total: '100', used: '40' }).left, 60);
  assert.equal(normalize({ total: 'abc' }).total, 0);
});

test('aggregate：packages 全部经 normalize 输出', () => {
  const r = aggregate([{ total: 10, used: 4, source: 's1' }]);
  assert.equal(r.packages.length, 1);
  assert.equal(r.packages[0].left, 6);
  assert.equal(r.expiring.length, 0, '无 expire_at 不进 expiring');
});

test('aggregate：expiring 按到期时间升序且最多 10 条', () => {
  const raw = [];
  for (let i = 12; i >= 1; i--) {
    raw.push({ total: 10, used: 0, expire_at: ahead(i), granted_at: ago(1), source: 'x' });
  }
  const r = aggregate(raw);
  assert.equal(r.expiring.length, 10, '12 个未用完包只提示最近 10 个');
  assert.ok(r.expiring[0].expire_at < r.expiring[9].expire_at, '升序：最近到期在前');
  assert.ok(r.expiring[0].expire_at - Date.now() <= 1 * DAY + 1000, '第一位是最早到期的那个（ahead(1)）');
});

test('aggregate：expired_unused = 已过期且还有余额；用尽的过期包不算', () => {
  const r = aggregate([
    { total: 10, used: 0, expire_at: ago(1), source: 's' },   // 过期 + 有余 → 计入
    { total: 10, used: 10, expire_at: ago(1), source: 's' },  // 过期 + 用尽 → 不计入
    { total: 10, used: 0, expire_at: ahead(5), source: 's' }, // 未过期 → 不计入
  ]);
  assert.equal(r.expired_unused.length, 1);
});

test('aggregateBySource：同源累加、active_days 去重、first/last 为发放日极值', () => {
  const r = aggregate([
    { total: 10, used: 1, granted_at: ago(5), source: 'daily' },
    { total: 20, used: 2, granted_at: ago(3), source: 'daily' },
    { total: 30, used: 3, granted_at: ago(3), source: 'daily' }, // 同一天不重复计 active_days
    { total: 40, used: 4, granted_at: ago(1), source: 'growth' },
  ]);
  const daily = r.sources.find((s) => s.source === 'daily');
  assert.equal(daily.count, 3);
  assert.equal(daily.total, 60);
  assert.equal(daily.used, 6);
  assert.equal(daily.left, 54);
  assert.equal(daily.active_days, 2);
  // days_since_last = floor((now - last_at)/86400000)：ago(3) 距今恰满 3 天
  assert.equal(daily.days_since_last, 3);
  const growth = r.sources.find((s) => s.source === 'growth');
  assert.equal(growth.active_days, 1);
  // sources 按 total 降序
  assert.ok(r.sources[0].total >= r.sources[1].total);
});

test('aggregateBySource：无 granted_at 的包不参与天数统计但计入金额', () => {
  const r = aggregate([{ total: 5, used: 0, source: 'mystery' }]);
  const s = r.sources.find((x) => x.source === 'mystery');
  assert.equal(s.total, 5);
  assert.equal(s.first_at, null);
  assert.equal(s.days_since_last, null);
});

test('aggregateBySource：未知来源归入 "(未知来源)"', () => {
  const r = aggregate([{ total: 1, used: 0 }]);
  assert.equal(r.sources[0].source, '(未知来源)');
});

test('aggregate：daily_grant 按发放日聚合并按日期升序', () => {
  const r = aggregate([
    { total: 10, used: 1, granted_at: ago(2), source: 's' },
    { total: 20, used: 0, granted_at: ago(2), source: 's' },
    { total: 5, used: 0, granted_at: ago(1), source: 's' },
    { total: 9, used: 0, source: 's' }, // 无发放日不进曲线
  ]);
  assert.equal(r.daily_grant.length, 2);
  assert.equal(r.daily_grant[0].granted, 30, '同一天两个包累加（10+20）');
  assert.equal(r.daily_grant[1].granted, 5);
  assert.ok(r.daily_grant[0].day < r.daily_grant[1].day, '升序');
});

test('aggregate：rawPackages 为 null/undefined 时安全返回空结构', () => {
  const r = aggregate(null);
  assert.deepEqual(r.packages, []);
  assert.deepEqual(r.expiring, []);
  assert.deepEqual(r.sources, []);
  assert.deepEqual(r.daily_grant, []);
  const r2 = aggregate(undefined, { note: 'x' });
  assert.equal(r2.note, 'x', 'extra 参数透传');
});
