// src/admin/auth.js - 管理员口令、签名会话、登录锁定（对应参考 server/security.py）
const crypto = require('crypto');
const path = require('path');
const { readJSON, writeJSON, appendJSONL } = require('./store');

const USERS_FILE = 'admin-users.json';
const SECRET_FILE = 'admin.secret';

// N 必须是 2 的幂（Node 的 scrypt 校验参数时会直接抛 RangeError），
// 262144 = 2^18 是常用的强度档，等价于参考实现那个量级的迭代成本。
const N_COST = 262144;
const R_BLOCK = 8;
const P_PARALLEL = 1;
const KEYLEN = 32;
const MAX_FAILS = 5;
const LOCK_SECONDS = 600;
const MAX_TRACKED = 5000;
const SESSION_DAYS = 1;
const SESSION_IDLE_HOURS = 12;
const COOKIE_NAME = 'dumate_admin';

const secretPath = () => path.join(require('./store').DATA_DIR, SECRET_FILE);

// 128 * N * r = 256MB，Node 默认 maxmem 只有 32MB，不显式抬高就会抛
// "memory limit exceeded"。校验侧同样要带，否则读别人的 hash 时又撞上。
const MAXMEM = 512 * 1024 * 1024;

function _scrypt(pwd, salt, n) {
  return crypto.scryptSync(pwd, salt, KEYLEN, { N: n, r: R_BLOCK, p: P_PARALLEL, maxmem: MAXMEM });
}

function makeHash(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = _scrypt(pwd, salt, N_COST).toString('hex');
  return `scrypt$${N_COST}$${salt}$${dk}`;
}

function verifyPwd(pwd, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = parseInt(parts[1], 10);
  if (!Number.isInteger(n) || n <= 0) return false;
  const expected = _scrypt(pwd, parts[2], n);
  const actual = Buffer.from(parts[3], 'hex');
  // 长度不等时 timingSafeEqual 会抛异常，先挡掉
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// session 签名密钥与用户表分开存：密钥泄露不该连带把口令库也交出去
function secret() {
  let s = readJSON(SECRET_FILE, null);
  if (!s || typeof s !== 'string') {
    s = crypto.randomBytes(32).toString('hex');
    writeJSON(SECRET_FILE, s);
  }
  return s;
}

function _sign(payload, key) {
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

function issueToken(username, role) {
  // 必须带上用户当前的 session_version：重设密码/踢会话会把它加一，
  // 写死 0 的话新签发的 token 立刻就被自己的校验判为过期，
  // 表现为「登录接口返回成功，但下一个请求就 401」。
  const data = users() || {};
  const u = data[username];
  const obj = {
    u: username,
    r: role,
    iat: Date.now(),
    orig: Date.now(),
    ver: u ? (u.session_version || 0) : 0,
  };
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${payload}.${_sign(payload, secret())}`;
}

function parseToken(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = _sign(payload, secret());
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expect, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function idleExpired(obj) {
  if (!SESSION_IDLE_HOURS) return false;
  return Date.now() - obj.iat > SESSION_IDLE_HOURS * 3600 * 1000;
}

function absoluteExpired(obj) {
  return Date.now() - obj.orig > SESSION_DAYS * 24 * 3600 * 1000;
}

const users = () => readJSON(USERS_FILE, null);

// 首次启动没有用户时生成管理员。初始密码只在 stdout 出现一次——
// 写进文件等于在磁盘上留一份明文口令。
function bootstrapUsers() {
  const existing = users();
  if (existing && Object.keys(existing).length) return { users: existing, created: null };

  const pwd = crypto.randomBytes(9).toString('base64url');
  const data = {
    admin: {
      username: 'admin',
      role: 'admin',
      hash: makeHash(pwd),
      created_at: Date.now(),
      session_version: 0,
    },
  };
  writeJSON(USERS_FILE, data);
  return { users: data, created: pwd };
}

function saveUsers(data) {
  return writeJSON(USERS_FILE, data);
}

// 初始密码只在首次启动打印一次，日志被清掉或 data/ 被搬走后就再也拿不回来，
// 而 bootstrap 看到已有用户不会再生成——管理员会被永久锁在自己门外。
// 这个开关是唯一的本地补救路径，只在显式传入时执行。
// 允许指定密码：随机串要靠手抄，11 位里错一个字符就白跑一轮。
function resetAdminPassword(plain) {
  const pwd = plain || crypto.randomBytes(9).toString('base64url');
  const data = users() || {};
  data.admin = {
    username: 'admin',
    role: 'admin',
    hash: makeHash(pwd),
    created_at: (data.admin && data.admin.created_at) || Date.now(),
    session_version: (data.admin && data.admin.session_version || 0) + 1,
  };
  saveUsers(data);
  return pwd;
}

function revokeSessions(username) {
  const data = users() || {};
  const u = data[username];
  if (!u) return 0;
  u.session_version = (u.session_version || 0) + 1;
  saveUsers(data);
  return u.session_version;
}

// ---- 登录失败锁定 ----
// 存内存而不是磁盘：进程重启后计数器归零是可接受的（攻击者拿不到更多尝试机会），
// 而落盘会在断电后留下陈旧锁定把管理员自己锁在外面。
const fails = {};

function _prune() {
  const keys = Object.keys(fails);
  if (keys.length <= MAX_TRACKED) return;
  keys.sort((a, b) => fails[a].at - fails[b].at);
  for (const k of keys.slice(0, keys.length - MAX_TRACKED)) delete fails[k];
}

function loginBlocked(ip, username) {
  const rec = fails[`${ip}|${username || ''}`];
  if (!rec || rec.n < MAX_FAILS) return false;
  if (Date.now() - rec.at > LOCK_SECONDS * 1000) {
    delete fails[`${ip}|${username || ''}`];
    return false;
  }
  return true;
}

function lockRemaining(ip, username) {
  const rec = fails[`${ip}|${username || ''}`];
  if (!rec || rec.n < MAX_FAILS) return 0;
  return Math.max(0, Math.ceil((LOCK_SECONDS * 1000 - (Date.now() - rec.at)) / 1000));
}

function recordFail(ip, username) {
  const key = `${ip}|${username || ''}`;
  const rec = fails[key];
  if (rec && Date.now() - rec.at > LOCK_SECONDS * 1000) {
    fails[key] = { n: 1, at: Date.now() };
  } else {
    fails[key] = { n: (rec ? rec.n : 0) + 1, at: rec && rec.n >= MAX_FAILS ? rec.at : Date.now() };
  }
  _prune();
}

function clearFail(ip, username) {
  delete fails[`${ip}|${username || ''}`];
}

function audit(actor, action, target = '', detail = '') {
  appendJSONL('admin-audit.jsonl', {
    ts: Date.now(),
    actor: actor || 'anonymous',
    action,
    target,
    detail,
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 返回当前登录用户；未登录返回 null。session_version 用于「改密码后踢掉旧会话」。
function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const obj = parseToken(token);
  if (!obj) return null;
  if (idleExpired(obj) || absoluteExpired(obj)) return null;
  const data = users() || {};
  const u = data[obj.u];
  if (!u) return null;
  if ((u.session_version || 0) !== (obj.ver || 0)) return null;
  return { username: u.username, role: u.role };
}

module.exports = {
  COOKIE_NAME,
  MAX_FAILS,
  LOCK_SECONDS,
  N_COST,
  secretPath,
  makeHash,
  verifyPwd,
  issueToken,
  parseToken,
  bootstrapUsers,
  resetAdminPassword,
  users,
  saveUsers,
  revokeSessions,
  loginBlocked,
  lockRemaining,
  recordFail,
  clearFail,
  audit,
  parseCookies,
  currentUser,
};
