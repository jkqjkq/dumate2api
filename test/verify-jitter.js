// test/verify-jitter.js - 节奏抖动与确定性错峰的离线验证（不需要起服务、不需要账号）
//
// 覆盖点：
//   1. hashUnit 确定性 + 落在 [0,1)
//   2. 多账号偏移**真的被打散**（分桶检验，不是只验区间）
//   3. staggerMs 跨进程一致（同 key 同值）、span<=0 行为不回退
//   4. retryJitterMs 落在区间内且**每次独立采样**（确定性会废掉它的用途）
//   5. catalogJitterMs 只追加不缩短、ratio 夹在 [0,1]
//   6. backoffMs 指数增长 + 封顶 + 叠抖动后不超 cap
//   7. sleep 的边界（0 / 负数不阻塞）
//
// 跑法：node test/verify-jitter.js

const assert = require('assert');
const j = require('../src/jitter');

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
async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${e.message}`);
  }
}

(async () => {
  console.log('\nverify-jitter: 节奏抖动与确定性错峰\n');

  // 1. hashUnit 确定性 + 区间
  check('hashUnit 同一 key 恒返回同一个值（跨调用一致）', () => {
    const a = j.hashUnit('acct-1');
    const b = j.hashUnit('acct-1');
    assert.strictEqual(a, b, '同 key 两次调用结果不同，错峰就失去"跨重启不变"的意义');
  });

  check('hashUnit 不同 key 给出不同值', () => {
    assert.notStrictEqual(j.hashUnit('acct-1'), j.hashUnit('acct-2'));
  });

  check('hashUnit 落在 [0,1)', () => {
    for (let i = 0; i < 200; i++) {
      const v = j.hashUnit(`k-${i}`);
      assert.ok(v >= 0 && v < 1, `hashUnit(k-${i}) = ${v} 越界`);
    }
  });

  // 2. 分布检验：200 个账号摊在 1 小时窗口里，10 个桶不该有空桶级别的聚集。
  // 只验区间会放过"全部挤在第一个桶"的实现——那正是错峰要解决的问题。
  check('200 个账号的错峰偏移落在 >=8 个不同十分桶（真被打散）', () => {
    const span = 3600 * 1000;
    const buckets = new Set();
    for (let i = 0; i < 200; i++) {
      const off = j.staggerMs(`acct-${i}`, span);
      assert.ok(off >= 0 && off < span, `offset ${off} 越界`);
      buckets.add(Math.floor((off / span) * 10));
    }
    assert.ok(buckets.size >= 8, `只落在 ${buckets.size} 个十分桶，分布过于集中`);
  });

  // 3. staggerMs 确定性 / 边界
  check('staggerMs 同 key 同 span 恒等（跨重启不变）', () => {
    assert.strictEqual(j.staggerMs('acct-7', 60000), j.staggerMs('acct-7', 60000));
  });

  check('staggerMs 的 key 区分带领域分隔（stagger 与 catalog 不共用偏移）', () => {
    // 同一账号的"刷新错峰"与"目录刷新抖动"不该是同一个数，否则两处同步
    assert.notStrictEqual(
      j.staggerMs('acct-7', 60000),
      j.catalogJitterMs('acct-7', 60000, 1),
    );
  });

  check('staggerMs span<=0 返回 0（关掉错峰时行为不回退）', () => {
    assert.strictEqual(j.staggerMs('acct-1', 0), 0);
    assert.strictEqual(j.staggerMs('acct-1', -5), 0);
    assert.strictEqual(j.staggerMs('acct-1', NaN), 0);
  });

  // 4. retryJitterMs：区间 + 独立性
  check('retryJitterMs 落在 [min,max)', () => {
    for (let i = 0; i < 300; i++) {
      const v = j.retryJitterMs({ min: 50, max: 250 });
      assert.ok(v >= 50 && v < 250, `retryJitter = ${v} 越界`);
    }
  });

  check('retryJitterMs 每次独立采样（不是确定性）', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(j.retryJitterMs());
    // 50 次采样在 200ms 窗口里至少出现若干不同值；确定性实现会只有 1 个
    assert.ok(seen.size > 5, `50 次采样只有 ${seen.size} 个不同值，疑似被做成确定性`);
  });

  check('retryJitterMs max<=min 时返回 min（不抛错、不返回 NaN）', () => {
    assert.strictEqual(j.retryJitterMs({ min: 100, max: 100 }), 100);
    assert.strictEqual(j.retryJitterMs({ min: 100, max: 50 }), 100);
  });

  // 5. catalogJitterMs：只追加
  check('catalogJitterMs 只追加不缩短（偏移量恒 >= 0）', () => {
    for (let i = 0; i < 200; i++) {
      const v = j.catalogJitterMs(`acct-${i}`, 300000, 0.2);
      assert.ok(v >= 0, `catalogJitter = ${v} 出现负值，会把刷新时刻提前`);
      assert.ok(v <= 300000 * 0.2 + 1, `catalogJitter = ${v} 超过 span*ratio`);
    }
  });

  check('catalogJitterMs ratio 非法时夹到 [0,1] 而不是 NaN', () => {
    const v1 = j.catalogJitterMs('a', 100000, 5);
    const v2 = j.catalogJitterMs('a', 100000, -1);
    assert.ok(Number.isFinite(v1) && v1 <= 100000, `ratio=5 时得到 ${v1}`);
    assert.ok(Number.isFinite(v2) && v2 === 0, `ratio=-1 时得到 ${v2}`);
  });

  check('catalogJitterMs span<=0 返回 0', () => {
    assert.strictEqual(j.catalogJitterMs('a', 0), 0);
  });

  // 6. backoffMs
  check('backoffMs 随 attempt 指数增长', () => {
    const o = { min: 0, max: 0 }; // 关掉抖动，只看指数部分
    assert.ok(j.backoffMs(2, o) > j.backoffMs(1, o), '第 2 次不比第 1 次长');
    assert.ok(j.backoffMs(3, o) > j.backoffMs(2, o), '第 3 次不比第 2 次长');
  });

  check('backoffMs 封顶后不继续增长', () => {
    const o = { min: 0, max: 0, cap: 10000 };
    assert.strictEqual(j.backoffMs(20, o), 10000);
  });

  check('backoffMs 叠抖动后不超过 cap（抖动不能把退避顶穿）', () => {
    for (let i = 0; i < 100; i++) {
      const v = j.backoffMs(10, { base: 5000, cap: 300000 });
      assert.ok(v <= 300000, `backoff = ${v} 超过 cap`);
      assert.ok(v > 0, `backoff = ${v} 非正`);
    }
  });

  check('backoffMs attempt<=0 按第 1 次算（不产生 NaN 或负数）', () => {
    const v = j.backoffMs(0, { base: 1000, cap: 300000 });
    assert.ok(v >= 1000 && v <= 300000, `backoff(0) = ${v}`);
  });

  // 7. sleep 边界
  await checkAsync('sleep(0) 与 sleep(负数) 立即返回，不阻塞', async () => {
    const t0 = Date.now();
    await j.sleep(0);
    await j.sleep(-10);
    await j.sleep(NaN);
    assert.ok(Date.now() - t0 < 500, '零/负 sleep 阻塞了');
  });

  await checkAsync('sleep(30) 真的等了 >=25ms', async () => {
    const t0 = Date.now();
    await j.sleep(30);
    assert.ok(Date.now() - t0 >= 25, 'sleep 没有真正等待');
  });

  console.log(`\n${failures ? `FAILED: ${failures} 项` : 'ALL PASSED'}\n`);
  process.exit(failures ? 1 : 0);
})();
