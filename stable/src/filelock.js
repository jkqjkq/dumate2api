// src/filelock.js - 跨进程文件锁（最小 lockfile 实现，零依赖）
//
// 为什么需要：网关（server.js）、管理端（admin/server.js）、web 网关
// （web-gateway.js）是三个独立进程，都按 mtime 失效重读同一批 data/*.json，
// 且两个以上进程会写同一批文件。进程内的「读-改-写」是同步代码、天然串行；
// 跨进程没有任何互斥——两个进程同时 load→改→save 时，后写者会用手里的
// 旧快照覆盖先写者的结果。refresh token 是轮换的（qwenwork/auth.js 的
// exchange 注释自认「新的一定要存」），旧快照盖掉新 token 等于把账号写废。
//
// 实现：O_EXCL 独占创建 `<目标>.lock`（Windows 上是 CreateFile CREATE_NEW，
// 同样原子）。拿不到就同步重试到死限；锁内容写 pid + 时刻，持锁进程已死
// （进程不存在）或锁年龄超限（正常临界区只有毫秒级）时允许后来者拆锁，
// 避免一次崩溃把文件锁死。
//
// 等待用 Atomics.wait 同步睡眠——所有写侧都是同步代码，用异步锁反而要把
// 全部调用点改成 async；Atomics.wait 不可用时退化为忙等（持锁时间毫秒级，
// 可接受）。
const fs = require('fs');

const STALE_MS = 10000; // 锁文件超过这个年龄视为孤儿
const WAIT_MS = 10000;  // 抢锁总死限，超时抛错而不是永远等

const backoffBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => {
  try { Atomics.wait(backoffBuf, 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* 忙等兜底 */ } }
};

const lockPathFor = (target) => `${target}.lock`;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function tryAcquire(target) {
  const lp = lockPathFor(target);
  try {
    const fd = fs.openSync(lp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() })); }
    finally { fs.closeSync(fd); }
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

// 拆孤儿锁：持锁进程已死，或锁年龄超过 STALE_MS（进程活着但已卡死的兜底）
function stealIfStale(target) {
  const lp = lockPathFor(target);
  let info = null;
  try { info = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch (e) { return false; }
  const stale = !info || !Number.isInteger(info.pid) || !pidAlive(info.pid)
    || Date.now() - (info.ts || 0) > STALE_MS;
  if (!stale) return false;
  try { fs.unlinkSync(lp); } catch (e) { return false; }
  return true;
}

function acquire(target, deadline = Date.now() + WAIT_MS) {
  for (;;) {
    if (tryAcquire(target)) return;
    stealIfStale(target);
    if (Date.now() >= deadline) {
      throw new Error(`filelock: acquire timeout for ${lockPathFor(target)}`);
    }
    sleepSync(5);
  }
}

function release(target) {
  try { fs.unlinkSync(lockPathFor(target)); } catch (e) { /* 已被拆走 */ }
}

/**
 * 原子替换写盘的最后一步（tmp → target）要带 EPERM/EBUSY 重试。Windows 上
 * 杀软会在文件刚关闭后短暂持有句柄，renameSync 随机报 EPERM——一次抖动就
 * 会穿过 withLock（release 的 unlink 同样失败），锁文件孤儿化后同进程内
 * 后续所有写盘都级联超时（实测 test/verify-qoder-throttle.js 六连败即此因，
 * 线上 data/pool-state.json 走同一条路径）。退避极短（40~160ms），只为穿过
 * 扫描窗口；全同步，锁内可用。
 */
function renameAtomic(tmp, target) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, target); return; }
    catch (e) {
      const retryable = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!retryable || i >= 4) throw e;
      sleepSync(40 * (i + 1));
    }
  }
}

/**
 * 在锁内跑一次同步的「读-改-写」。锁的粒度是单个数据文件
 * （`data/keys.json` ↔ `data/keys.json.lock`）。
 *
 * 调用约定：fn 的第一行应当把模块缓存置为失效（`cache = { mtime: -1, data: null }`），
 * 保证锁内 load() 读到的是别人刚写完的值，而不是自己进程里的旧快照。
 */
function withLock(target, fn) {
  acquire(target);
  try { return fn(); } finally { release(target); }
}

module.exports = { withLock, acquire, release, renameAtomic, lockPathFor };
