// test/verify-pool-pick.js - 选号（加权抽签 / 防撞号 / 快过期优先）的离线验证
//
// 不需要起服务、不需要账号、不写任何 data 文件（pool 用 file:null 纯内存）。
//
// 覆盖点：
//   1. rr 模式行为不回退（仍是严格轮询）
//   2. 加权模式：每个候选都有机会，且**额度高的号概率更高**
//   3. 关键不变量：credits=0 的号**不会被饿死**（加性权重的意义）
//   4. 防撞号窗口：窗口内不重复选中同一号
//   5. 窗口内无可用号时按**单调序号**兜底，而不是墙钟（同毫秒会退化）
//   6. 快过期优先：标了 expiring 的号优先，且不影响其他过滤
//   7. 既有过滤（exclude / 冷却 / 在途帽 / 空候选）不被新逻辑破坏
//
// 跑法：node test/verify-pool-pick.js

const assert = require('assert');
const { createPool } = require('../src/pool');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${e.message}`);
  }
}

/** 纯内存池。now 固定，避免测试受真实时钟影响。 */
function mk(opts = {}) {
  let t = 1700000000000;
  const p = createPool({
    file: null,
    now: () => t,
    ...opts,
  });
  return { p, setNow: (v) => { t = v; } };
}

/** 抽样 n 次，返回每个 id 被选中的次数 */
function sample(p, candidates, n, opts = {}) {
  const hits = {};
  for (let i = 0; i < n; i++) {
    const id = p.pick(candidates, opts);
    if (id == null) continue;
    hits[id] = (hits[id] || 0) + 1;
  }
  return hits;
}

console.log('\nverify-pool-pick: 选号加权 / 防撞号 / 快过期优先\n');

// 1. rr 模式不回退
check('rr 模式仍是严格轮询（关掉防撞号窗口后 a,b,c,a,b,c）', () => {
  const { p } = mk({ pickMode: 'rr', pickGapMs: 0 });
  const got = [];
  for (let i = 0; i < 6; i++) got.push(p.pick(['a', 'b', 'c'], { pickGapMs: 0 }));
  assert.deepStrictEqual(got, ['a', 'b', 'c', 'a', 'b', 'c'], `实际 ${got.join(',')}`);
});

// 2. 加权：每个候选都有机会 + 高额度概率更高
check('加权模式：所有候选都会被选中（无饿死）', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0 });
  p.setCredits('rich', 100, 100);
  p.setCredits('poor', 5, 100);
  const hits = sample(p, ['rich', 'poor'], 400, { pickGapMs: 0 });
  assert.ok(hits.rich > 0 && hits.poor > 0, `分布 ${JSON.stringify(hits)}`);
});

check('加权模式：额度高的号被选中次数明显更多（额度加成生效）', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0, idleBonusMax: 0, idleBonusPerHour: 0 });
  p.setCredits('rich', 100, 100);
  p.setCredits('poor', 5, 100);
  const hits = sample(p, ['rich', 'poor'], 600, { pickGapMs: 0 });
  // rich 权重 1+10=11，poor 权重 1+0.5=1.5 → rich 应占约 88%
  assert.ok(hits.rich > hits.poor * 3, `rich=${hits.rich} poor=${hits.poor}，额度加成没生效`);
});

// 3. 关键不变量：credits=0 不被饿死
check('credits=0 的号仍会被选中（加性权重，不是乘性）', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0 });
  p.setCredits('rich', 100, 100);
  p.setCredits('zero', 0, 0);
  const hits = sample(p, ['rich', 'zero'], 400, { pickGapMs: 0 });
  assert.ok(hits.zero > 0, `零额度号一次都没被选中 = 被饿死（分布 ${JSON.stringify(hits)}）`);
  assert.ok(hits.rich > hits.zero, `额度加成失效（分布 ${JSON.stringify(hits)}）`);
});

// 4. 防撞号窗口
check('防撞号窗口：窗口内连续 pick 不会连选同一号', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 60000 });
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push(p.pick(['a', 'b']));
  for (let i = 1; i < seq.length; i++) {
    assert.notStrictEqual(seq[i], seq[i - 1], `第 ${i} 次与上一次同为 ${seq[i]}`);
  }
});

check('防撞号窗口关闭（pickGapMs=0）时允许连选同一号', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0 });
  // 只留一个候选：无论如何都只能是它
  assert.strictEqual(p.pick(['only']), 'only');
  assert.strictEqual(p.pick(['only']), 'only');
});

// 5. 单调序号兜底（而不是墙钟）
check('窗口内无可用号时按单调序号取最旧者（同毫秒不退化成恒取第一个）', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 60000 });
  // 固定时钟：所有 last_pick_at 都会等于同一个 now，墙钟判据在这里必然退化
  const first = p.pick(['a', 'b']);
  const second = p.pick(['a', 'b']);
  assert.notStrictEqual(first, second, '同毫秒下退化成恒取同一个号（说明判据用了墙钟）');
  // 第三个回到第一个（LRU 轮转）
  const third = p.pick(['a', 'b']);
  assert.strictEqual(third, first, `期望轮转回 ${first}，实际 ${third}`);
});

// 6. 快过期优先
check('快过期优先：标了 expiring 的号被优先选中', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0 });
  p.setCredits('a', 100, 100);
  p.setCredits('b', 100, 100);
  p.setCredits('soon', 100, 100);
  const expiring = new Set(['soon']);
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(p.pick(['a', 'b', 'soon'], { expiring, pickGapMs: 0 }), 'soon');
  }
});

check('快过期集合里的号不健康时不硬选（回落到普通候选）', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0 });
  p.setCredits('a', 100, 100);
  p.noteError('soon', { kind: 'soft', message: 'upstream throttle' });
  const id = p.pick(['a', 'soon'], { expiring: new Set(['soon']), pickGapMs: 0 });
  assert.strictEqual(id, 'a', `冷却中的快过期号不该被选中，实际 ${id}`);
});

// 7. 既有过滤不被破坏
check('exclude 仍然生效', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0 });
  assert.strictEqual(p.pick(['a', 'b'], { exclude: ['a'], pickGapMs: 0 }), 'b');
});

check('全部被 exclude 时返回 null', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0 });
  assert.strictEqual(p.pick(['a', 'b'], { exclude: ['a', 'b'], pickGapMs: 0 }), null);
});

check('空候选返回 null', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0 });
  assert.strictEqual(p.pick([], { pickGapMs: 0 }), null);
  assert.strictEqual(p.pick(null, { pickGapMs: 0 }), null);
});

check('冷却中的号不进候选（既有行为不变）', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0 });
  p.noteError('a', { kind: 'soft', message: 'throttle' });
  assert.strictEqual(p.pick(['a', 'b'], { pickGapMs: 0 }), 'b');
});

check('在途帽仍然生效（inFlightMax=1 时打满即不可选）', () => {
  const { p } = mk({ pickMode: 'weighted', pickGapMs: 0, inFlightMax: 1 });
  assert.strictEqual(p.acquire('a'), true);
  assert.strictEqual(p.pick(['a', 'b'], { pickGapMs: 0 }), 'b');
});

console.log(`\n${failures ? `FAILED: ${failures} 项` : 'ALL PASSED'}\n`);
process.exit(failures ? 1 : 0);
