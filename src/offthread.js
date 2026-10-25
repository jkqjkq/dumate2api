// src/offthread.js - 同步 CPU 热点挪出事件循环的最小 worker 通道（审计 P1-5）
//
// 用法：`run(modulePath, fnName, args, fallback)` —— 懒启动一个 worker，
// 在 worker 里 `require(modulePath)` 并调用其导出的 fnName，返回 Promise。
// 同一模块一个 worker、任务串行执行：登录 / 签名这类低频热点不需要并发度，
// 串行还天然限流（scrypt 每次要 256MB 内存，并行只会更快 OOM）。
// worker 空闲 3 秒自动退出（见 WORKER_SRC 里的注释——Node 24 下 unref 不能
// 让主进程退出），下个任务懒重建，对低频热点等于无感。
//
// fallback：worker 起不来或崩溃时回退到调用方给的同步实现（通常是同一个
// 计算的同步版）——宁可退化成旧行为，也不能让登录/签名直接不可用。fn 本身
// 抛错也会进 fallback：同步版会抛出同样的真实错误，语义一致。
const { Worker } = require('worker_threads');

const WORKER_SRC = `
const { parentPort } = require('worker_threads');
const mod = require(process.env.OFFTHREAD_MODULE);
// 空闲自终止：Node 24 实测主进程侧的 worker.unref() 不再让主进程自然退出
// （worker 线程的活跃 handle 被计入主进程退出判定），一次性任务进程跑完会
// 因此挂住不退。这里空闲 3 秒自杀；主进程的 'exit' 监听会把通道置回未启动、
// 在途 promise 以 'worker exited' 拒绝（进调用方的 fallback），下个任务重建。
let idle = null;
const armIdle = () => {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), 3000);
  if (idle.unref) idle.unref();
};
armIdle();
parentPort.on('message', (job) => {
  if (idle) { clearTimeout(idle); idle = null; }
  try {
    const out = mod[job.fn](...job.args);
    parentPort.postMessage({ ok: true, out });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  } finally {
    armIdle();
  }
});
`;

const channels = new Map(); // modulePath → { worker, pending, queue }

function ensureWorker(modulePath) {
  let ch = channels.get(modulePath);
  if (ch && ch.worker) return ch;
  ch = { worker: null, pending: null, queue: Promise.resolve() };
  channels.set(modulePath, ch);
  const w = new Worker(WORKER_SRC, {
    eval: true,
    env: { ...process.env, OFFTHREAD_MODULE: modulePath },
  });
  w.unref(); // 不因它阻止进程退出
  w.on('message', (msg) => {
    const p = ch.pending; ch.pending = null;
    if (!p) return;
    if (msg && msg.ok) p.resolve(msg.out);
    else p.reject(new Error((msg && msg.error) || 'worker task failed'));
  });
  w.on('error', (e) => {
    ch.worker = null;
    const p = ch.pending; ch.pending = null;
    if (p) p.reject(e);
  });
  w.on('exit', () => {
    if (ch.worker === w) ch.worker = null;
    const p = ch.pending; ch.pending = null;
    if (p) p.reject(new Error('worker exited'));
  });
  ch.worker = w;
  return ch;
}

function run(modulePath, fnName, args, fallback) {
  const exec = () => {
    let ch;
    try { ch = ensureWorker(modulePath); }
    catch (e) { return Promise.reject(e); }
    const job = ch.queue.then(() => new Promise((resolve, reject) => {
      if (!ch.worker) return reject(new Error('worker unavailable'));
      ch.pending = { resolve, reject };
      try { ch.worker.postMessage({ fn: fnName, args }); }
      catch (e) { ch.pending = null; reject(e); }
    }));
    ch.queue = job.catch(() => {}); // 失败不堵后续任务
    return job;
  };
  return exec().catch((e) => {
    if (typeof fallback === 'function') return fallback(...args);
    throw e;
  });
}

module.exports = { run };
