// src/scrypt-task.js - worker 侧的 scrypt 计算（admin/auth.js 经 offthread.js 调用）
//
// 算法参数与 admin/auth.js 的同步版完全一致（N 由存量 hash 自带、r=8、p=1）。
// 放在独立模块是为了让 worker 按路径 require——admin/auth.js 自身依赖
// store.js 等带副作用面的模块，不适合整个搬进 worker。
const crypto = require('crypto');

const KEYLEN = 32;
const R_BLOCK = 8;
const P_PARALLEL = 1;
// 128 * N * r = 256MB，Node 默认 maxmem 只有 32MB，不显式抬高就会抛
// "memory limit exceeded"。校验侧同样要带，否则读别人的 hash 时又撞上。
const MAXMEM = 512 * 1024 * 1024;

function scrypt({ pwd, salt, n }) {
  return crypto.scryptSync(pwd, salt, KEYLEN, { N: n, r: R_BLOCK, p: P_PARALLEL, maxmem: MAXMEM }).toString('hex');
}

module.exports = { scrypt };
