// test/filelock.test.js - filelock.js 行为测试（审计 P1-2 跨进程文件锁）
//
// 覆盖：互斥窗口、释放幂等、超时快速抛错（用可注入的 deadline，不真等
// WAIT_MS）、孤儿锁两条拆锁路径（持锁进程已死 / 锁年龄超限）。
// 注意：不要在测试里嵌套 withLock 同一目标——那会等满 10 秒超时。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { makeTmpData } = require('./helpers/tmpdata');

const filelock = require('../src/filelock');
const tmp = makeTmpData('filelock');

// 一个已退出的进程 pid：spawn 立即退出后其 pid 短期内不会被复用
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
  assert.ok(child.pid > 0);
  return child.pid;
}

function target(name) { return tmp.file(`${name}.json`); }

test('lockPathFor：锁文件与目标同目录同名加 .lock 后缀', () => {
  assert.equal(filelock.lockPathFor('D:/x/data/keys.json'), 'D:/x/data/keys.json.lock');
});

test('withLock：临界区内锁文件存在（含 pid/ts），退出即释放', () => {
  const t = target('crit');
  filelock.withLock(t, () => {
    const raw = JSON.parse(fs.readFileSync(`${t}.lock`, 'utf8'));
    assert.equal(raw.pid, process.pid);
    assert.ok(Math.abs(Date.now() - raw.ts) < 5000);
    assert.ok(fs.existsSync(`${t}.lock`));
  });
  assert.ok(!fs.existsSync(`${t}.lock`));
});

test('withLock：fn 抛错也释放（finally 语义）', () => {
  const t = target('throw');
  assert.throws(() => filelock.withLock(t, () => { throw new Error('inner'); }), /inner/);
  assert.ok(!fs.existsSync(`${t}.lock`));
});

test('互斥：目标已被持锁时，过期的 deadline 让 acquire 立即超时抛错', () => {
  const t = target('mutex');
  filelock.acquire(t);
  try {
    assert.throws(() => filelock.acquire(t, Date.now() - 1), /filelock: acquire timeout/);
  } finally { filelock.release(t); }
  assert.ok(!fs.existsSync(`${t}.lock`));
});

test('孤儿锁（持锁进程已死）：后来者拆锁成功', () => {
  const t = target('deadpid');
  fs.writeFileSync(`${t}.lock`, JSON.stringify({ pid: deadPid(), ts: Date.now() }));
  filelock.acquire(t);
  filelock.release(t);
  assert.ok(!fs.existsSync(`${t}.lock`));
});

test('孤儿锁（锁年龄超限）：即使 pid 还活着也可拆', () => {
  const t = target('staleage');
  fs.writeFileSync(`${t}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() - 20000 }));
  filelock.acquire(t, Date.now() + 1000);
  filelock.release(t);
});

test('活跃锁不被误拆：pid 活、锁新鲜时 deadline 内拿到锁前不拆锁', () => {
  const t = target('alive');
  filelock.acquire(t);
  try {
    // 死限压到 50ms 内：期间锁不被拆（stale 判据不满足），acquire 必然超时
    assert.throws(() => filelock.acquire(t, Date.now() + 50), /timeout/);
    assert.ok(fs.existsSync(`${t}.lock`), '活跃锁应仍在');
  } finally { filelock.release(t); }
});

test('release 幂等：锁不存在时不抛', () => {
  const t = target('nolock');
  filelock.release(t);
  filelock.release(t);
});

test('损坏的锁文件：无法判定 pid/年龄时不拆锁，等待超限抛错（保守语义）', () => {
  const t = target('corrupt');
  fs.writeFileSync(`${t}.lock`, 'not json at all');
  assert.throws(() => filelock.acquire(t, Date.now() + 200), /acquire timeout/);
  fs.unlinkSync(`${t}.lock`); // 清场，不影响后续用例
});

test('withLock 返回 fn 的返回值', () => {
  const t = target('retval');
  assert.equal(filelock.withLock(t, () => 42), 42);
});
