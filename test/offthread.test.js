// test/offthread.test.js - offthread.js 行为测试（审计 P1-5 worker 通道）
//
// 覆盖：worker 正常执行与结果回传、fn 抛错进 fallback（且 fallback 收到
// 原始 args）、无 fallback 时向上抛真实错误、坏模块（加载即崩）走 fallback、
// 多参数透传、串行队列不互相吞结果、空闲自终止后懒重建（E/F 修复点）。
// worker 空闲会自终止（默认 3s，测试经 OFFTHREAD_IDLE_MS 注入短时长），
// 测试进程可以正常退出。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const offthread = require('../src/offthread');

const TARGET = require.resolve('./helpers/fixtures/offthread-target');
// 加载即抛 SyntaxError 的模块：worker require 失败 → 'error' 事件 → reject → fallback
const BROKEN = require.resolve('./helpers/fixtures/offthread-broken');
// 独立通道：空闲自终止测试必须用没被本文件其他用例 spawn 过的路径，
// 才能保证 worker 是以注入的短空闲时长启动的
const REBUILD = require.resolve('./helpers/fixtures/offthread-rebuild');

test('run：worker 里执行模块导出函数并回传结果', async () => {
  assert.equal(await offthread.run(TARGET, 'add', [1, 2]), 3);
  assert.equal(await offthread.run(TARGET, 'echo', ['你好']), '你好');
});

test('run：多参数按序透传', async () => {
  assert.equal(await offthread.run(TARGET, 'add', [10, 32]), 42);
});

test('run：fn 抛错时回退到 fallback，fallback 收到原始 args', async () => {
  const seen = [];
  const out = await offthread.run(TARGET, 'boom', [7, 8], (...args) => { seen.push(args); return 'fb'; });
  assert.equal(out, 'fb');
  assert.deepEqual(seen, [[7, 8]]);
});

test('run：无 fallback 时向上抛 worker 里的真实错误', async () => {
  await assert.rejects(() => offthread.run(TARGET, 'boom', []), /kaboom/);
});

test('run：模块加载即崩（worker error）也走 fallback 而不是挂死', async () => {
  const out = await offthread.run(BROKEN, 'anything', [1], (x) => `sync:${x}`);
  assert.equal(out, 'sync:1');
});

test('run：串行队列——前一个失败不吞掉后一个任务的结果', async () => {
  const [a, b, c] = await Promise.all([
    offthread.run(TARGET, 'add', [1, 1]),
    offthread.run(TARGET, 'boom', [], () => 'recovered'),
    offthread.run(TARGET, 'add', [2, 2]),
  ]);
  assert.equal(a, 2);
  assert.equal(b, 'recovered');
  assert.equal(c, 4);
});

test('run：空闲自终止后下个任务懒重建（Node 24 下一次性进程不再挂住）', async () => {
  // 注入短空闲时长：worker 干完一单 150ms 后自杀；主进程侧通道必须随之
  // 置回未启动，下一个任务重建新 worker 拿到正确结果（而不是挂死或
  // 拿到 'worker exited' 拒绝）。
  process.env.OFFTHREAD_IDLE_MS = '150';
  try {
    assert.equal(await offthread.run(REBUILD, 'add', [3, 3]), 6); // 首单：spawn + 执行
    await new Promise((r) => setTimeout(r, 500));                 // 超 150ms：worker 已自杀
    assert.equal(await offthread.run(REBUILD, 'echo', ['rebuilt']), 'rebuilt'); // 懒重建
  } finally {
    delete process.env.OFFTHREAD_IDLE_MS;
  }
});
