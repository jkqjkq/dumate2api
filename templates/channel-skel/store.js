// templates/channel-skel/store.js - per-channel 凭据存储骨架（七件套缺项补齐）
//
// **这是模板，不是运行时代码**：新通道接入时复制到 `src/<channel>/store.js`，
// 填好下方 CHANNEL 块的三个值，再按需裁剪字段。
//
// 为什么要有这个文件（对照 Buddy2api 七件套的 store.py）：此前三条直连通道的
// 凭据落盘散在管理端路由（admin/routes/<ch>.js）里，通道包不自含——管理端
// 路由直接操文件，通道包反而只能被动读。收口成 per-channel store 后：
//   - 管理端路由只调 store 的方法，不碰文件路径与写盘细节
//   - 「凭证文件在哪、怎么加锁、怎么原子写」全通道只有这一份答案
//   - 新通道接入时凭据持久化从第一行起就是对齐的
//
// 提炼自 src/qoder/auth.js（家族里最新的实现，qwenwork / traework 的 auth.js
// 与它同构）。字段差异见 CHANNEL.fields——按上游实际给的凭证形态增删。
//
// 三条铁纪律（改模板前先读 src/filelock.js 文件头）：
//   1. **mtime 失效重读**：网关与管理端是两个进程，写侧改动必须能被读侧看见
//   2. **tmp+rename 原子写**：进程中途被杀不能留下半截 JSON
//   3. **filelock 包住一切读改写**：refresh token 是轮换的，两个进程无锁
//      RMW 时后写者会用旧快照盖掉新 token（等于把账号写废）
'use strict';

const fs = require('fs');
const path = require('path');
// 相对路径按**落位后**（src/<ch>/store.js）写：与 src/qoder/auth.js 一致。
// 模板本身留在 templates/ 下不做 require 解析。
const filelock = require('../filelock');
const fileperm = require('../fileperm');

// ==== CHANNEL：复制后必须改的三个值 =====================================
const CHANNEL = {
  /** 凭据文件名（data/ 下）：约定 `<channel>-accounts.json` */
  FILE: '<channel>-accounts.json',
  /** 指定主账号的环境变量名：约定 `DUMATE_<CHANNEL>_ACCOUNT` */
  ENV_ACCOUNT: 'DUMATE_<CHANNEL>_ACCOUNT',
  /**
   * 「凭证完整」的判据：findUsable 只放行返回 true 的账号。
   * 按上游凭证形态改（Qoder 是 accessToken + refreshToken 双件套）。
   */
  isComplete: (a) => !!(a && a.accessToken && a.refreshToken),
  /** 列表接口的脱敏展示字段（按需增删；token 一律不外传，只给尾 6 位） */
  present: (a) => ({
    id: a.id,
    nickname: a.nickname || '',
    enabled: a.enabled !== false,
    preferred: !!a.preferred,
    expiresAt: a.expiresAt || null,
    hasRefresh: !!a.refreshToken,
    hasAccess: !!a.accessToken,
    refreshTail: a.refreshToken ? String(a.refreshToken).slice(-6) : '',
  }),
};
// ========================================================================

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return path.join(dataDir(), CHANNEL.FILE);
}

/** 读全部账号。mtime 失效重读：别的进程写完，这里下一次调用就能看到 */
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

/** 原子写：先 .tmp 再 rename；token 类文件权限收紧到当前用户可读 */
function save(data) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fileperm.harden(tmp);
  fs.renameSync(tmp, target);
  cache = { mtime: fs.statSync(target).mtimeMs, data };
  return data;
}

/** 列表：脱敏投影，凭证明文与完整 token 永不出 store */
function list() {
  return load().accounts.map(CHANNEL.present);
}

function get(id) {
  return load().accounts.find((a) => a.id === Number(id) || a.id === id) || null;
}

/** 可用账号：启用的、凭证完整的 */
function findUsable() {
  return load().accounts.filter((a) => a.enabled !== false && CHANNEL.isComplete(a));
}

/**
 * 主账号：preferred 标记 → 环境变量指定 → 第一个可用。
 * 三通道同一顺序（preferred 稳定、环境变量是临时覆盖、第一个只作兜底），
 * 别发明新顺序——账号卡上的「主账号」徽标全靠它一致。
 */
function preferred() {
  const usable = findUsable();
  if (!usable.length) return null;
  const envId = String(process.env[CHANNEL.ENV_ACCOUNT] || '').trim();
  if (envId) {
    const byEnv = usable.find((a) => String(a.id) === envId);
    if (byEnv) return byEnv;
  }
  return usable.find((a) => a.preferred) || usable[0];
}

/** 新增或按 uid / id 覆盖。preferred=true 时清掉其他账号的标记 */
function upsert(acc) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
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
  });
}

/** 局部更新。lastError 与 lastErrorAt 同步移动（全通道同一约定） */
function patch(id, fields) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const a = data.accounts.find((x) => x.id === Number(id));
    if (!a) return null;
    const f = { ...(fields || {}) };
    if (f.preferred === true) {
      for (const x of data.accounts) if (x.id !== a.id) x.preferred = false;
    }
    if (f.lastError !== undefined) {
      f.lastErrorAt = f.lastError ? Date.now() : null;
    }
    Object.assign(a, f);
    save(data);
    return a;
  });
}

function remove(id) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const before = data.accounts.length;
    data.accounts = data.accounts.filter((a) => a.id !== Number(id));
    if (data.accounts.length === before) return false;
    // 删掉主账号时顺延给第一个，否则选号静默退化成「取第一个」却没人知道
    if (!data.accounts.some((a) => a.preferred) && data.accounts.length) {
      data.accounts[0].preferred = true;
    }
    save(data);
    return true;
  });
}

/** token 是否在 skewMs 内过期（默认提前 5 分钟）。无 expiresAt 视为需要刷新 */
function needsRefresh(a, skewMs = 300000) {
  if (!a || !a.expiresAt) return true;
  return Date.now() + skewMs >= a.expiresAt;
}

module.exports = {
  FILE: CHANNEL.FILE, dataDir, filePath, load, save,
  list, get, findUsable, preferred, upsert, patch, remove, needsRefresh,
};
