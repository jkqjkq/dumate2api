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
    // 手机号：只给脱敏形式。完整值只留在账号文件里（PII）
    phone: maskPhone(a.phone),
    // 来源必须一起给——TRAE 这个号是从昵称推断的，不是接口下发的真手机号。
    // 界面要据此标注，否则用户会以为和千问一样是官方数据。
    phoneSource: a.phone ? (a.phoneSource || 'inferred-nickname') : '',
    enabled: a.enabled !== false,
    // createdAt 供仪表盘的「账号存活天数」用（见 admin/routes/traework.js
    // 的 /dashboard）。不外传这个字段的话那边只能恒给 null。
    createdAt: a.createdAt || null,
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

/**
 * 手机号脱敏：157****1251。
 *
 * 号码是 PII，列表接口一律只给脱敏形式——认号用「前缀 + 后 4 位」足够了，
 * 没必要把完整号码裸在页面上（管理端页面可能被投屏/截图）。
 * 完整值只留在 data/ 的账号文件里，与 token 同级对待。
 */
function maskPhone(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  const plus = s.startsWith('+') ? '+' : '';
  const digits = s.replace(/^\+/, '');
  // 先剥国家码再脱敏。国内号是 86 + 11 位，不剥的话切出来会是「861****」
  // 而不是「157****」——认号时要的是本机号的前 3 位。
  let body = digits;
  let cc = '';
  if (digits.length === 13 && digits.startsWith('86')) {
    cc = '86';
    body = digits.slice(2);
  }
  if (body.length >= 7) {
    return `${plus}${cc}${body.slice(0, 3)}****${body.slice(-4)}`;
  }
  return `${plus}${cc}${body.slice(0, 1)}****`;
}

/**
 * 尝试从昵称里抽手机号。
 *
 * TRAE 的 GetUserInfo 已 401（拿不到官方身份字段），昵称是唯一的身份线索。
 * 曾以为上游默认昵称形如「用户<手机号>」——**实测是错的**：本机这个号是
 * 「用户23062830688」，11 位但以 2 开头，不是手机号格式，也与 uid 无关。
 *
 * 所以这里只在昵称**严格**匹配「用户 + 标准手机号」时才认，其他一律不给。
 * 严格一点是为了不把不是手机号的数字显示成手机号——那比不显示更糟。
 * 实测本机 TRAE 账号就抽不到，界面显示「手机号未知」，这是正确的结果。
 */
function phoneFromNickname(nickname) {
  const m = String(nickname || '').match(/^用户(1[3-9]\d{9})$/);
  return m ? m[1] : '';
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

/** 从 JWT 里取 user id（sub / data.id 都认） */
function jwtUid(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return '';
    const j = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return String((j && j.data && j.data.id) || (j && j.sub) || '');
  } catch (e) { return ''; }
}

/**
 * 补齐账号的设备标识。
 *
 * **签到能不能成功取决于这个**：新的 TRAE JWT 会校验设备指纹，随机编一个
 * 会被恒定拒（表现为 9074）。所以三个值都从 uid 确定性派生——同一账号
 * 每次算出来一样，且与参考实现（TraeWorkAssistant）完全一致。
 *
 * 旧账号（deviceId 是 32 位随机 hex 的）会被就地纠正：那种格式服务端不认。
 * 判定标准是「15 位纯数字」，不合规就重派生。
 */
function ensureDevice(a) {
  if (!a) return null;
  const uid = a.uid || jwtUid(a.accessToken) || '';
  if (!uid) return a;
  const ok = a.deviceId && /^\d{15}$/.test(a.deviceId) && a.sessionId && a.marketUserId;
  if (ok) return a;
  const d = require('./device').deriveDevice(uid);
  return patch(a.id, {
    deviceId: d.deviceId,
    sessionId: d.sessionId,
    marketUserId: d.marketUserId,
    deviceDerivedFrom: uid,
  }) || { ...a, ...d };
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
  needsRefresh, exchange, jwtExp, jwtUid, fetchUserInfo, ensureDevice,
  maskPhone, phoneFromNickname, genId,
};
