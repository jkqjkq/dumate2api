// src/accounts.js - 多账号存储（百度搭子网页端）
//
// 与 keys.js 的区别：key 是「我们签发给调用方的凭证」，只存哈希即可；
// 账号 cookie 是「上游签发给我们的凭证」，必须能原样取出来去调上游，
// 所以只能明文存。这也意味着 data/ 目录的权限就是这些账号的权限边界，
// 界面上要如实说明这一点。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const FILE = 'web-accounts.json';

let cache = { mtime: -1, data: null };

function filePath() {
  return path.join(DATA_DIR, FILE);
}

function mtimeOf() {
  try { return fs.statSync(filePath()).mtimeMs; } catch (e) { return 0; }
}

function load() {
  const mtime = mtimeOf();
  if (cache.data && cache.mtime === mtime) return cache.data;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (e) { raw = null; }
  const data = { accounts: Array.isArray(raw && raw.accounts) ? raw.accounts : [] };
  cache = { mtime, data };
  return data;
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  cache = { mtime: mtimeOf(), data };
  return data;
}

// 从 cookie 串里抽出关键身份字段。不解析全部，只取判断归属和展示要用的。
function parseCookie(cookieStr) {
  const out = {};
  for (const part of String(cookieStr || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// 从 cookie 里能拿到的身份线索。BDUSS 本身不含昵称，昵称要调接口才知道，
// 所以这里只做「这份 cookie 是否具备基本要素」的判定。
function cookieSummary(cookieStr) {
  const c = parseCookie(cookieStr);
  const has = (k) => Object.prototype.hasOwnProperty.call(c, k) && c[k];
  return {
    has_bduss: has('BDUSS'),
    has_stoken: has('STOKEN'),
    has_ptoken: has('PTOKEN'),
    // 用于界面上区分账号，不用于鉴权
    bduss_tail: has('BDUSS') ? c.BDUSS.slice(-6) : '',
    baiduid: c.BAIDUID || '',
  };
}

function normalizeCookie(raw) {
  // 用户可能整段粘贴（含 "Cookie: " 前缀、换行、多余空格），清洗一下
  let s = String(raw || '').trim();
  s = s.replace(/^cookie:\s*/i, '');
  s = s.replace(/[\r\n]+/g, '; ');
  s = s.replace(/;\s*;/g, ';');
  s = s.replace(/;\s*$/, '');
  return s.trim();
}

/**
 * 把一个账号记录转成**对外形状**。
 *
 * **所有访问器（list/get/create/update）都必须经过这里**，否则同一个账号
 * 会因为「用了哪个访问器」而叫两个名字——这正是之前的 bug：list() 解析了
 * 显示名而 get() 没有，`accounts.get(id).name` 拿到的是占位名「账号 N」。
 * 收敛到一处就不再有「改了 9 个模块漏了 3 个调用点」这种漂移。
 *
 * 关键约定：
 *   - `name` **覆盖**成解析后的显示名（调用方直接渲染即可）
 *   - `label` 保留用户填的原始标签
 *   - `cookie` 一律不外传（明文凭证不出接口）
 */
function toPublic(a) {
  if (!a) return null;
  return {
    ...a,
    label: a.name,
    name: displayName(a),
    cookie: undefined,
    cookie_len: (a.cookie || '').length,
    cookie_summary: cookieSummary(a.cookie),
    // 账号存活天数（从 created_at 算到今天）。仪表盘账号健康快照用——
    // 与「会员剩余天数」是两回事，那个是额度有效期，这是账号用了多久。
    // 没有 created_at（很早以前加的账号）就 null，界面显示 —
    daysAlive: a.created_at ? Math.floor((Date.now() - a.created_at) / 86400000) : null,
  };
}

function list() {
  return load().accounts.map(toPublic);
}

/**
 * 账号在界面上该显示的名字。**优先级：用户填的名字 > 上游昵称 > 占位名**。
 *
 * 关键是把 `create()` 自动生成的占位名「账号 N」识别出来并跳过——它只是
 * 为了「name 非空」而写的，不代表用户真的想叫这个账号。不跳过的话，
 * 手动粘贴添加（没填名字）的账号会永久显示「账号 1」，即使上游返回了
 * 「张三」也不会被用上。
 *
 * 只匹配 `账号 <数字>` 这一种形态（含全角空格），不做模糊匹配——
 * 用户真想起名叫「账号 1」时不该被我们覆盖掉。
 */
function displayName(a) {
  if (!a) return '';
  const name = String(a.name || '').trim();
  const isPlaceholder = /^账号\s*\d+$/.test(name);
  if (name && !isPlaceholder) return name;
  const nick = String(a.nickname || '').trim();
  if (nick) return nick;
  return name || `账号 ${a.id}`;
}

/**
 * 取单个账号（**对外形状**，已解析显示名）。
 *
 * 需要**原始记录**（拿去改盘、读 cookie）时用 `getRaw()`——两者不要混用：
 * toPublic 会把 name 换成显示名、把 cookie 抹掉，拿它回写会污染数据。
 */
function get(id) {
  return toPublic(getRaw(id));
}

/** 原始账号记录（含 cookie）。仅供内部改盘使用，不出接口 */
function getRaw(id) {
  return load().accounts.find((a) => a.id === Number(id)) || null;
}

function create(opts = {}) {
  const data = load();
  const cookie = normalizeCookie(opts.cookie);
  if (!cookie) throw new Error('cookie 不能为空');
  const sum = cookieSummary(cookie);
  if (!sum.has_bduss) {
    // BDUSS 是百度登录态的核心字段，没有它调任何接口都会 401。
    // 与其存下来到调用时才失败，不如现在就说清缺什么。
    throw new Error('cookie 里没有 BDUSS，请确认复制的是完整 Cookie（需包含 BDUSS）');
  }

  // 同一个 BDUSS 重复添加没有意义，会变成两个账号各自签到——但签到本身
  // 按账号去重，所以后果是列表里出现两条一样的记录，容易被误读成两个账号
  const dup = data.accounts.find((a) => cookieSummary(a.cookie).bduss_tail === sum.bduss_tail);
  if (dup) throw new Error(`该账号已存在（${dup.name}）`);

  const id = data.accounts.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
  const now = Date.now();
  const account = {
    id,
    name: String(opts.name || '').trim() || `账号 ${id}`,
    cookie,
    created_at: now,
    updated_at: now,
    enabled: opts.enabled !== false,
    // 上游返回的身份信息，首次调接口后回填
    uid: '',
    nickname: '',
    last_login_ok_at: null,
    last_error: '',
    // 签到状态
    checkin: {
      last_at: null,
      last_result: '',
      total_times: null,
      sign_in_days: [],
      month_points: null,
    },
    // 抽奖状态
    lottery: {
      remaining: null,
      last_at: null,
      last_result: '',
      my_prizes: [],
    },
    // 积分缓存
    points: null,
    points_at: null,
  };
  data.accounts.push(account);
  save(data);
  return toPublic(account);
}

function update(id, patch = {}) {
  const data = load();
  const a = data.accounts.find((x) => x.id === Number(id));
  if (!a) return null;
  if (patch.name !== undefined) a.name = String(patch.name).trim() || a.name;
  if (patch.enabled !== undefined) a.enabled = !!patch.enabled;
  if (patch.cookie !== undefined) {
    const c = normalizeCookie(patch.cookie);
    const sum = cookieSummary(c);
    if (!sum.has_bduss) throw new Error('cookie 里没有 BDUSS');
    a.cookie = c;
  }
  a.updated_at = Date.now();
  save(data);
  return toPublic(a);
}

// 内部使用：直接改账号记录（签到结果、积分缓存等），不回显 cookie
function patchInternal(id, patch = {}) {
  const data = load();
  const a = data.accounts.find((x) => x.id === Number(id));
  if (!a) return null;
  Object.assign(a, patch);
  a.updated_at = Date.now();
  save(data);
  return a;
}

function remove(id) {
  const data = load();
  const before = data.accounts.length;
  data.accounts = data.accounts.filter((x) => x.id !== Number(id));
  if (data.accounts.length === before) return false;
  save(data);
  return true;
}

module.exports = {
  filePath,
  load,
  save,
  list,
  get,
  getRaw,
  toPublic,
  create,
  update,
  patchInternal,
  remove,
  parseCookie,
  cookieSummary,
  normalizeCookie,
  displayName,
};
