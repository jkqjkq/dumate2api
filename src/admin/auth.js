// src/admin/auth.js - 管理员口令、签名会话、登录锁定（对应参考 server/security.py）
const crypto = require('crypto');
const path = require('path');
const { readJSON, writeJSON, appendJSONL } = require('./store');

const USERS_FILE = 'admin-users.json';
const SECRET_FILE = 'admin.secret';

const ITERATIONS = 260000;
const KEYLEN = 32;
const MAX_FAILS = 5;
const LOCK_SECONDS = 600;
const MAX_TRACKED = 5000;
const SESSION_DAYS = 1;
const SESSION_IDLE_HOURS = 12;
const COOKIE_NAME = 'dumate_admin';

const secretPath = () => path.join(require('./store').DATA_DIR, SECRET_FILE);

function makeHash(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(pwd, salt, KEYLEN, { N: ITERATIONS }).toString('hex');
  return `scrypt$${ITERATIONS}$${salt}$${dk}`;
}

function verifyPwd(pwd, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = parseInt(parts[1], 10);
  const expected = crypto.scryptSync(pwd, parts[2], KEYLEN, { N: n });
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
  const obj = {
    u: username,
    r: role,
    iat: Date.now(),
    orig: Date.now(),
    ver: 0,
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
  ITERATIONS,
  secretPath,
  makeHash,
  verifyPwd,
  issueToken,
  parseToken,
  bootstrapUsers,
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
