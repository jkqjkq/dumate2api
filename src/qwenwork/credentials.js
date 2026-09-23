// src/qwenwork/credentials.js - 读千问办公的登录态（auth-v2.dat）
//
// 千问办公是桌面客户端，登录态存在 Electron safeStorage 加密的文件里：
//   %APPDATA%\QwenWorkCN\auth-v2.dat        ← v10 + AES-256-GCM 密文
//   %APPDATA%\QwenWorkCN\Local State        ← os_crypt.encrypted_key（DPAPI 保护）
//
// 解密链：Local State 的 encrypted_key → 去 "DPAPI" 前缀 → DPAPI(CurrentUser)
// 解包 → 32B AES key → 解 auth-v2.dat（12B nonce + 密文 + 16B tag）。
//
// 只在 Windows 上成立（DPAPI 是 Windows 专有）。macOS 走 Keychain，本项目
// 不支持——与整个项目「仅 Windows」的定位一致。
//
// 重要：**不复制这个文件到本项目 data/ 目录下**。官方客户端会刷新它，
// 复制一份立刻过期；且 refresh token 是轮换的，客户端和我们在同一份文件上
// 各刷一次就会互踩。直接读原文件、刷新后写回原文件。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const USER_DATA_DIR = () => path.join(process.env.APPDATA || '', 'QwenWorkCN');
const MACHINE_ID_PATH = () =>
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.qoderworkcn', '.auth', 'machine_id');

let dpapiCache = null; // { mtime, key }

/**
 * 取 AES key：Local State 里的 encrypted_key 经 DPAPI 解包得到 32 字节。
 * 按 Local State 的 mtime 缓存——DPAPI 解包要起 PowerShell 进程，
 * 每次请求都跑一遍会让首字延迟平白多出几百毫秒。
 */
function aesKey() {
  const lsPath = path.join(USER_DATA_DIR(), 'Local State');
  let mtime = 0;
  try { mtime = fs.statSync(lsPath).mtimeMs; } catch (e) {
    throw new Error(`QwenWork Local State 不存在（${lsPath}）；请先登录千问办公客户端`);
  }
  if (dpapiCache && dpapiCache.mtime === mtime) return dpapiCache.key;

  let b64;
  try {
    const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
    b64 = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
  } catch (e) {
    throw new Error('QwenWork Local State 解析失败：' + e.message);
  }
  if (!b64) throw new Error('QwenWork Local State 缺少 os_crypt.encrypted_key');

  const raw = Buffer.from(b64, 'base64');
  if (raw.slice(0, 5).toString() !== 'DPAPI') {
    throw new Error('os_crypt.encrypted_key 不是 DPAPI 格式（App-Bound 加密需要另外取 key）');
  }

  // DPAPI 解包走 PowerShell：Node 没有原生 DPAPI 绑定，而引入第三方原生模块
  // 会破坏本项目「零依赖」的约束。项目里已有 PowerShell 调用的先例。
  const tmp = path.join(require('os').tmpdir(), `qw-dpapi-${process.pid}.bin`);
  fs.writeFileSync(tmp, raw.slice(5));
  let out;
  try {
    const ps = [
      'Add-Type -AssemblyName System.Security;',
      `$b=[IO.File]::ReadAllBytes('${tmp}');`,
      "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');",
      '[Convert]::ToBase64String($p)',
    ].join(' ');
    out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 清理失败不影响主流程 */ }
  }
  const key = Buffer.from(out, 'base64');
  if (key.length !== 32) throw new Error(`DPAPI 解包得到的 AES key 长度异常：${key.length}（应为 32）`);

  dpapiCache = { mtime, key };
  return key;
}

/** 解 auth-v2.dat → 登录态对象 */
function decryptAuth(file) {
  const target = file || path.join(USER_DATA_DIR(), 'auth-v2.dat');
  const blob = fs.readFileSync(target);
  if (blob.slice(0, 3).toString() !== 'v10') {
    throw new Error('auth-v2.dat 不是 Chromium v10 格式');
  }
  const nonce = blob.slice(3, 15);
  const rest = blob.slice(15);
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), nonce);
  d.setAuthTag(rest.slice(rest.length - 16));
  const plain = Buffer.concat([d.update(rest.slice(0, -16)), d.final()]).toString('utf8');
  const doc = JSON.parse(plain);
  if (!doc || typeof doc !== 'object') throw new Error('auth-v2.dat 解密后不是对象');
  return doc;
}

/** 写回 auth-v2.dat（刷新 token 后用，保持与官方客户端同一份文件） */
function encryptAuth(doc, file) {
  const target = file || path.join(USER_DATA_DIR(), 'auth-v2.dat');
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(), nonce);
  const body = Buffer.concat([c.update(JSON.stringify(doc), 'utf8'), c.final()]);
  const out = Buffer.concat([Buffer.from('v10', 'utf8'), nonce, body, c.getAuthTag()]);
  // 原子写：写 .tmp 再 rename。中途被 kill 会留下半个文件，客户端就登不上了。
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, target);
}

/**
 * 官方客户端签名用的 machine id。抓包显示它用自己那份，而不是导入时记录的
 * 设备 id；两边不一致会导致签名不匹配。
 */
function machineId() {
  try { return fs.readFileSync(MACHINE_ID_PATH(), 'utf8').trim(); } catch (e) { return ''; }
}

/** token 是否在 skewMs 内过期（默认提前 5 分钟刷新，避免请求打到一半失效） */
function isExpired(doc, skewMs = 300000) {
  const exp = doc && doc.expiresAt ? Date.parse(doc.expiresAt) : NaN;
  if (!Number.isFinite(exp)) return false; // 没过期时间就当作不过期
  return Date.now() + skewMs >= exp;
}

module.exports = {
  USER_DATA_DIR,
  MACHINE_ID_PATH,
  decryptAuth,
  encryptAuth,
  machineId,
  isExpired,
};
