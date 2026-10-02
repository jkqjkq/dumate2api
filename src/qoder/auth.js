// src/qoder/auth.js - Qoder 账号池存储与 token 续期
//
// 与 src/qwenwork/auth.js 同构（同样自持凭证、多账号、按 mtime 失效重读、
// 原子写），差异在**字段**：Qoder 的凭证是 device_token(dt-xxx) + refresh_token(drt-xxx)，
// 且有区域（cn / global）——两区账号不通用，各存各的。
//
// 为什么凭证要自己存而不是读客户端：与千问同理——客户端同一时刻只有一份
// 登录态，两个账号无法并存；而且 Qoder 的 device flow 可以完全脱离客户端跑
// （见 login.js），所以直接自持更干净。**这条通道不需要装 Qoder 客户端。**
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const c = require('./constants');

const FILE = 'qoder-accounts.json';

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

/** 读全部账号。按 mtime 失效重读（与 traework/auth.js 同一策略） */
let cache = { mtime: -1, data: null };
function load() {
  let mtime = 0;
  try { mtime = fs.statSync(filePath()).mtimeMs; } catch (e) { /* 文件不存在 */ }
  if (cache.data && cache.mtime === mtime) return cache.data;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch (e) { /* 坏文件当空 */ }
  const data = { accounts: Array.isArray(raw && raw.accounts) ? raw.accounts : [] };
  cache = { mtime, data };
  return data;
}

/** 原子写：先 .tmp 再 rename */
function save(data) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  cache = { mtime: fs.statSync(target).mtimeMs, data };
  return data;
}

/** 手机号脱敏：认号够用，又不把完整号码裸在页面上 */
function maskPhone(p) {
  const s = String(p || '');
  if (s.length < 7) return s ? '***' : '';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 列表（脱敏：device/refresh token 全量不外传，只给尾 6 位供人工核对） */
function list() {
  return load().accounts.map((a) => ({
    id: a.id,
    uid: a.uid || '',
    nickname: a.nickname || '',
    username: a.username || '',
    email: a.email || '',
    phoneMasked: maskPhone(a.phone),
    hasPhone: !!a.phone,
    region: c.normalizeRegion(a.region),
    userType: a.userType || '',
    planName: a.planName || '',
    enabled: a.enabled !== false,
    preferred: !!a.preferred,
    expiresAt: a.expiresAt || null,
    refreshExpiresAt: a.refreshExpiresAt || null,
    machineId: a.machineId || '',
    lastError: a.lastError || '',
    lastErrorAt: a.lastErrorAt || null,
    createdAt: a.createdAt || null,
    daysAlive: a.createdAt ? Math.floor((Date.now() - a.createdAt) / 86400000) : null,
    // 「凭证是否完整」以布尔形式带出——token 本身不外传，调用方需要知道有没有
    hasRefresh: !!a.refreshToken,
    hasAccess: !!a.accessToken,
    refreshTail: a.refreshToken ? String(a.refreshToken).slice(-6) : '',
  }));
}

function get(id) {
  return load().accounts.find((a) => a.id === Number(id) || a.id === id) || null;
}

/** 可用账号：启用的、凭证完整的 */
function findUsable() {
  return load().accounts.filter((a) => a.enabled !== false && a.accessToken && a.refreshToken);
}

/**
 * 主账号：preferred 优先 → 环境变量指定 → 第一个可用。
 * 与千问同一顺序（preferred 稳定、环境变量是临时覆盖、第一个只作兜底）。
 */
function preferred() {
  const usable = findUsable();
  if (!usable.length) return null;
  const envId = String(process.env.DUMATE_QODER_ACCOUNT || '').trim();
  if (envId) {
    const byEnv = usable.find((a) => String(a.id) === envId);
    if (byEnv) return byEnv;
  }
  const marked = usable.find((a) => a.preferred);
  if (marked) return marked;
  return usable[0];
}

/** 新增或按 uid / id 覆盖 */
function upsert(acc) {
  const data = load();
  const i = data.accounts.findIndex((a) => (acc.uid && a.uid === acc.uid) || (acc.id && a.id === acc.id));
  if (acc && acc.preferred === true) {
    for (const x of data.accounts) x.preferred = false;
  }
  if (i >= 0) {
    data.accounts[i] = { ...data.accounts[i], ...acc };
    save(data);
    return data.accounts[i];
  }
  const id = data.accounts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0) + 1;
  const rec = { id, enabled: true, createdAt: Date.now(), ...acc };
  if (rec.preferred === undefined) rec.preferred = data.accounts.length === 0;
  data.accounts.push(rec);
  save(data);
  return rec;
}

/** 局部更新。lastError 与 lastErrorAt 同步移动（与千问同一约定） */
function patch(id, fields) {
  const data = load();
  const a = data.accounts.find((x) => x.id === Number(id));
  if (!a) return null;
  if (fields && fields.preferred === true) {
    for (const x of data.accounts) if (x.id !== a.id) x.preferred = false;
  }
  // lastError 打时间戳：界面据此显示「N 分钟前」，避免把几小时前的瞬时
  // 错误读成「当前故障」。所有写 lastError 的调用方都走这里，集中一处。
  if (fields && fields.lastError !== undefined) {
    fields.lastErrorAt = fields.lastError ? Date.now() : null;
  }
  Object.assign(a, fields);
  save(data);
  return a;
}

function remove(id) {
  const data = load();
  const before = data.accounts.length;
  data.accounts = data.accounts.filter((a) => a.id !== Number(id));
  if (data.accounts.length === before) return false;
  // 删掉的是主账号时顺延给剩下的第一个，否则选号会静默退化成「取第一个」
  if (!data.accounts.some((a) => a.preferred) && data.accounts.length) {
    data.accounts[0].preferred = true;
  }
  save(data);
  return true;
}

/** token 是否在 skewMs 内过期。无 expiresAt 视为需要刷新 */
function needsRefresh(a, skewMs = 300000) {
  if (!a || !a.expiresAt) return true;
  return Date.now() + skewMs >= a.expiresAt;
}

module.exports = {
  FILE, dataDir, filePath, load, save, list, get, findUsable, preferred,
  upsert, patch, remove, needsRefresh, maskPhone,
};
