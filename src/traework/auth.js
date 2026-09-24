// src/traework/auth.js - 凭证存储与 token 刷新
//
// 与千问的关键差异：**不需要读客户端文件**。
// TRAE Work 的凭证由我们自己在登录流程里换取（见 login.js），
// 存到 data/traework-accounts.json —— 多账号就是多条记录。
//
// 这与搭子的 web-accounts.json 同构（都是我们自己持有凭证），
// 而不是千问那种「只读客户端 auth-v2.dat」。
//
// refreshToken 是**轮换**的：每次 ExchangeToken 都会返回新的，
// 必须原子落盘，否则旧 token 失效后账号就废了。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const c = require('./constants');
const { oauthHeaders } = require('./headers');

const FILE = 'traework-accounts.json';

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

/** 读全部账号。按 mtime 失效重读（与 keys.js / modelmap.js 同一策略） */
let cache = { mtime: -1, data: null };
function load() {
  let mtime = 0;
  try { mtime = fs.statSync(filePath()).mtimeMs; } catch (e) { /* 不存在 */ }
  if (cache.data && cache.mtime === mtime) return cache.data;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch (e) { /* 坏文件当空 */ }
  const data = { accounts: Array.isArray(raw && raw.accounts) ? raw.accounts : [] };
  cache = { mtime, data };
  return data;
}

/** 原子写：先 .tmp 再 rename。中途被 kill 不会留下半个 JSON */
function save(data) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  cache = { mtime: fs.statSync(target).mtimeMs, data };
  return data;
}

/** 生成 32 位十六进制设备标识（与开源实现的 openssl rand -hex 16 一致） */
function genId() {
  return crypto.randomBytes(16).toString('hex');
}

/** 列表（脱敏：不外传 refreshToken 全量） */
function list() {
  return load().accounts.map((a) => ({
    id: a.id,
    uid: a.uid || '',
    nickname: a.nickname || '',
    email: a.email || '',
    enabled: a.enabled !== false,
    expiresAt: a.expiresAt || null,
    refreshExpiresAt: a.refreshExpiresAt || null,
    credits: a.credits == null ? null : a.credits,
    lastCheckin: a.lastCheckin || null,
    lastError: a.lastError || '',
    deviceId: a.deviceId || '',
    // 只给尾部，便于人工核对是哪个账号
    refreshTail: a.refreshToken ? String(a.refreshToken).slice(-6) : '',
  }));
}

function get(id) {
  return load().accounts.find((a) => a.id === Number(id) || a.id === id) || null;
}

function findUsable() {
  return load().accounts.filter((a) => a.enabled !== false && a.accessToken && a.refreshToken);
}

/** 新增或按 uid 覆盖 */
function upsert(acc) {
  const data = load();
  const i = data.accounts.findIndex((a) => (acc.uid && a.uid === acc.uid) || (acc.id && a.id === acc.id));
  if (i >= 0) {
    data.accounts[i] = { ...data.accounts[i], ...acc };
    save(data);
    return data.accounts[i];
  }
  const id = data.accounts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0) + 1;
  const rec = { id, enabled: true, createdAt: Date.now(), ...acc };
  data.accounts.push(rec);
  save(data);
  return rec;
}

function remove(id) {
  const data = load();
  const before = data.accounts.length;
  data.accounts = data.accounts.filter((a) => a.id !== Number(id));
  if (data.accounts.length === before) return false;
  save(data);
  return true;
}

function patch(id, fields) {
  const data = load();
  const a = data.accounts.find((x) => x.id === Number(id));
  if (!a) return null;
  Object.assign(a, fields);
  save(data);
  return a;
}

/** token 是否在 skewMs 内过期 */
function needsRefresh(a, skewMs = 24 * 3600 * 1000) {
  if (!a || !a.expiresAt) return true;
  return Date.now() + skewMs >= a.expiresAt;
}

/**
 * 用 refreshToken 换新 token（refreshToken 会轮换）。
 * 成功后**由调用方**落盘（保持「读-改-写」在一次调用里，避免并发覆盖）。
 */
async function exchange(a) {
  if (!a || !a.refreshToken) return { ok: false, error: '缺少 refreshToken' };
  const host = a.apiHost || c.OAUTH_HOST;
  const body = {
    ClientID: c.CLIENT_ID,
    RefreshToken: a.refreshToken,
    ClientSecret: '-',
    UserID: '',
  };
  const r = await c.request(host, c.EP_EXCHANGE, {
    method: 'POST', body, headers: oauthHeaders(),
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const res = (r.data && r.data.Result) || r.data || {};
  const token = res.Token || res.token;
  if (!token) return { ok: false, error: '响应里没有 Token' };
  const out = { accessToken: token };
  if (res.RefreshToken) out.refreshToken = res.RefreshToken;
  // 到期时间：优先用 JWT 的 exp，其次用接口给的毫秒时间戳
  const exp = jwtExp(token);
  if (exp) out.expiresAt = exp;
  else if (res.ExpiresAt) out.expiresAt = Number(res.ExpiresAt);
  if (res.RefreshExpireAt) out.refreshExpiresAt = Number(res.RefreshExpireAt);
  return { ok: true, patch: out };
}

/** 从 JWT 里取 exp（秒 → 毫秒） */
function jwtExp(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const j = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return j && j.exp ? j.exp * 1000 : null;
  } catch (e) { return null; }
}

/** 取用户信息（登录后用一次，补 uid / 昵称） */
async function fetchUserInfo(a) {
  const r = await c.request(a.apiHost || c.OAUTH_HOST, c.EP_USER_INFO, {
    method: 'POST', body: {}, headers: { ...oauthHeaders(), Authorization: `Cloud-IDE-JWT ${a.accessToken}` },
  });
  if (r.status !== 200 || !r.data) return null;
  const res = (r.data && r.data.Result) || r.data || {};
  return {
    uid: String(res.UserID || res.userId || res.UID || ''),
    nickname: res.Nickname || res.nickname || res.UserName || '',
    email: res.Email || res.email || '',
  };
}

module.exports = {
  FILE, filePath, dataDir, load, save, list, get, findUsable, upsert, remove, patch,
  needsRefresh, exchange, jwtExp, fetchUserInfo, genId,
};
