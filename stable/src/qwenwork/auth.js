// src/qwenwork/auth.js - 千问办公凭证存储与 token 刷新
//
// 与 src/traework/auth.js 同构：凭证由我们自己持有，存到 data/ 下，
// 多账号就是多条记录。
//
// 这条通道以前只读官方客户端的 auth-v2.dat（Electron safeStorage 加密），
// 那份文件同一时刻只有一份登录态，所以两个账号无法并存、必须开客户端换。
// 逆向出客户端自己的登录方式后（见 login.js：OAuth device flow + PKCE），
// 我们也能自己拿凭证——于是「只认账号池」，不再碰客户端那个文件。
//
// 好处不只是能多账号：凭证在自己的文件里，刷新与落盘都在我们手上，
// 不存在「客户端和我们各写一次互相刷掉」的问题。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const c = require('./constants');

const FILE = 'qwenwork-accounts.json';

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

/** 列表（脱敏：token 全量不外传，只给 refresh 尾 6 位供人工核对） */
function list() {
  return load().accounts.map((a) => ({
    id: a.id,
    uid: a.uid || '',
    nickname: a.nickname || '',
    username: a.username || '',
    email: a.email || '',
    // 手机号只给脱敏形式：认号够用，又不把完整号码裸在页面上。
    // 完整值只留在账号文件里，与 token 同级对待
    phoneMasked: maskPhone(a.phone),
    hasPhone: !!a.phone,
    tier: a.tier || '',
    planId: a.planId || '',
    planName: a.planName || '',
    enabled: a.enabled !== false,
    preferred: !!a.preferred,
    expiresAt: a.expiresAt || null,
    refreshExpiresAt: a.refreshExpiresAt || null,
    machineId: a.machineId || '',
    lastError: a.lastError || '',
    // lastError 的写入时刻。界面据此显示「N 分钟前」——没有它，一条几小时前
    // 的瞬时错误会被读成「当前故障」（2026-10-02 实测踩到：账号页显示的
    // 403/402 其实早已自愈）。无 lastError 时为 null。
    lastErrorAt: a.lastErrorAt || null,
    createdAt: a.createdAt || null,
    // 「账号存活天数」供仪表盘展示——接口里没这字段，由 createdAt 算。
    // 没有 createdAt（旧数据兼容）就 null，界面显示「—」，不编天数
    daysAlive: a.createdAt ? Math.floor((Date.now() - a.createdAt) / 86400000) : null,
    // 「凭证是否完整」要以布尔形式带出来：refreshToken 本身不外传，
    // 但调用方（管理端的 usable 判定）需要知道有没有。
    // 不这么做的话 usable 只能拿被脱敏掉的字段判，结果恒为 false。
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
 * 主账号：preferred 优先，其次环境变量指定的 id，最后取第一个可用。
 *
 * 顺序为什么是这样：preferred 是用户在账号文件里定的（稳定），环境变量是
 * 临时覆盖（改启动参数不改文件）。两者都没配就取第一个——「第一个」在
 * 删号后会变，所以只作兜底，不该成为长期依赖。
 */
function preferred() {
  const usable = findUsable();
  if (!usable.length) return null;
  const envId = String(process.env.DUMATE_QWENWORK_ACCOUNT || '').trim();
  if (envId) {
    const byEnv = usable.find((a) => String(a.id) === envId);
    if (byEnv) return byEnv;
  }
  const marked = usable.find((a) => a.preferred);
  if (marked) return marked;
  return usable[0];
}

/** 新增或按 uid / id 覆盖。uid 相同视为同一个账号（重新登录同一个号） */
function upsert(acc) {
  const data = load();
  const i = data.accounts.findIndex((a) => (acc.uid && a.uid === acc.uid) || (acc.id && a.id === acc.id));
  // 主账号是排他的：任何写路径带 preferred:true 都要先清掉别人的。
  // 只在新账号时设 preferred 是不够的——绕过 upsert 直接传 preferred 的
  // 调用方（如探针、导入）会留下两个 true，选号就变成「看谁排在前面」。
  if (acc && acc.preferred === true) {
    for (const x of data.accounts) x.preferred = false;
  }
  if (i >= 0) {
    data.accounts[i] = { ...data.accounts[i], ...acc };
    save(data);
    return data.accounts[i];
  }
  const id = data.accounts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0) + 1;
  // 池里第一个账号自动成为主账号，否则一个账号时也要额外配一次
  const rec = { id, enabled: true, createdAt: Date.now(), ...acc };
  if (rec.preferred === undefined) rec.preferred = data.accounts.length === 0;
  data.accounts.push(rec);
  save(data);
  return rec;
}

function remove(id) {
  const data = load();
  const before = data.accounts.length;
  data.accounts = data.accounts.filter((a) => a.id !== Number(id));
  if (data.accounts.length === before) return false;
  // 删掉的是主账号时，把主账号顺延给剩下的第一个——否则池里没有 preferred，
  // 选号会静默退化成「取第一个」，用户以为是随机换的
  if (!data.accounts.some((a) => a.preferred) && data.accounts.length) {
    data.accounts[0].preferred = true;
  }
  save(data);
  return true;
}

function patch(id, fields) {
  const data = load();
  const a = data.accounts.find((x) => x.id === Number(id));
  if (!a) return null;
  // 设为主账号是排他的：置 true 时清掉其他账号的同标记
  if (fields && fields.preferred === true) {
    for (const x of data.accounts) if (x.id !== a.id) x.preferred = false;
  }
  // lastError 与 lastErrorAt 必须同步移动：所有写 lastError 的调用方
  // （index.js 的 markFailure、chat.js 的换票失败）都走这里，集中打时间戳
  // 比在每个调用点各写一次可靠——漏一处就会出现「有时间戳的错误」和
  // 「没时间戳的错误」两种形状，界面无法统一判断新鲜度。
  //
  // 为什么要时间戳：lastError **只在换票成功时才清空**，所以它经常停在
  // 很久以前的失败上。用户看到「Model is not available」会以为当前坏了，
  // 其实可能是几小时前那次瞬时抖动的残留。带上时刻才能显示「N 分钟前」。
  if (fields && fields.lastError !== undefined) {
    fields.lastErrorAt = fields.lastError ? Date.now() : null;
  }
  Object.assign(a, fields);
  save(data);
  return a;
}

/** token 是否在 skewMs 内过期 */
function needsRefresh(a, skewMs = 300000) {
  if (!a || !a.expiresAt) return true;
  return Date.now() + skewMs >= a.expiresAt;
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

/** 发一个 JSON 请求。统一用 StringDecoder——跨 chunk 的汉字逐块解码会变 U+FFFD */
function requestJson(pathname, method, body, headers, timeout = 20000) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = require('https').request({
      hostname: new URL(c.GATEWAY).hostname,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout,
    }, (res) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => {
        buf += dec.end();
        let data = null;
        try { data = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, data, raw: buf });
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, raw: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 用 refreshToken 换 device_token。
 *
 * **不落盘**：返回 patch 字段由调用方写回，保持「读-改-写」在一次调用里，
 * 避免并发刷新时后写的覆盖掉先写的（traework/auth.js 同一约定）。
 *
 * refresh token 是轮换的：每次返回新的，必须存下来。实测旧 token 不会被
 * 立即作废（同一 RT 连用多次都成功），但那不能当成设计保证——新的一定存。
 */
async function exchange(a) {
  if (!a || !a.refreshToken) return { ok: false, error: '缺少 refreshToken' };
  const r = await requestJson(c.REFRESH_PATH, 'POST', { refresh_token: a.refreshToken, target: 'c' }, {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': c.USER_AGENT,
    'X-Request-Id': crypto.randomUUID(),
    'Login-Version': c.LOGIN_VERSION,
  }, 30000);

  const token = (r.data && (r.data.device_token || r.data.token)) || '';
  if (!token) {
    // refresh 失败通常是凭证本身失效（refresh token 过期/被吊销）。
    // 报「未返回 device_token」会让人去查网络，其实该做的是重新登录一次。
    const code = (r.data && (r.data.errorCode || r.data.error)) || `HTTP ${r.status}`;
    const detail = (r.data && (r.data.errorMessage || r.data.message)) || String(r.raw || '').slice(0, 120);
    return { ok: false, error: `换票失败（${code}${detail ? ': ' + detail : ''}）`, expired: true };
  }

  const out = { accessToken: token };
  if (r.data.refresh_token) out.refreshToken = r.data.refresh_token;
  // 到期时间：优先 JWT 的 exp（服务端给的 expires_at 也可能有，两者一致时用 JWT）
  const exp = jwtExp(token) || (r.data.expires_at ? Date.parse(r.data.expires_at) : null);
  if (exp) out.expiresAt = exp;
  if (r.data.refresh_token_expires_at) {
    const t = Date.parse(r.data.refresh_token_expires_at);
    if (Number.isFinite(t)) out.refreshExpiresAt = t;
  }
  out.lastError = '';
  return { ok: true, patch: out };
}

/**
 * 取用户信息（登录后用一次，补 uid / 昵称 / 套餐）。
 * uid 是 wasm 签名的必需输入（prepareInfer 的 uid 参数），没有它发不出请求。
 */
async function fetchUserInfo(a) {
  const token = (a && (a.accessToken || a.access)) || '';
  if (!token) return null;
  const r = await requestJson(c.ACCOUNT_CONTEXT_PATH, 'GET', null, {
    Accept: 'application/json',
    'User-Agent': c.USER_AGENT,
    Authorization: `Bearer ${token}`,
  });
  if (r.status !== 200 || !r.data) return null;
  const d = (r.data && r.data.data) || r.data;
  const u = d.user || d;
  const plan = d.plan || {};
  return {
    uid: String(u.id || u.user_id || u.uid || ''),
    nickname: String(u.name || u.username || ''),
    username: String(u.username || u.user_name || ''),
    email: String(u.email || ''),
    tier: String(u.tier || plan.name || ''),
    planId: String(plan.pid || ''),
    planName: String(plan.name || ''),
  };
}

/**
 * 机器标识。
 *
 * 优先用客户端那份（~/.qoderworkcn/.auth/machine_id）——它是**已被证明能
 * 用于 wasm 签名**的值。随机生成一个也能登录，但服务端是否校验「签名用的
 * machine_id 必须等于登录时上报的那个」还没实测过（探针只验证到
 * account-context 与 wallets，没打过真实推理）。所以安全做法是沿用已验证的。
 *
 * 每个账号存一份自己的，之后不再改——改了等于换设备。
 */
function genMachineId() {
  try {
    const v = require('./credentials').machineId();
    if (v) return v;
  } catch (e) { /* 没装客户端就退回随机值 */ }
  return crypto.randomUUID();
}

/**
 * 取真实手机号。
 *
 * 不在 account-context 里（那里只有 phone_<uid>@phone.local 这种占位邮箱），
 * 要问 /api/v1/adapter/auth/identities 的 c_site_user。
 *
 * 拿不返回 null 而不是空串——「没拿到」和「这个号没绑手机」是两回事，
 * 界面上都要显示 —，但排查时得能区分。
 */
async function fetchPhone(a) {
  const token = (a && (a.accessToken || a.token)) || '';
  if (!token) return null;
  const r = await requestJson(c.IDENTITIES_PATH, 'GET', null, {
    Accept: 'application/json',
    'User-Agent': c.USER_AGENT,
    Authorization: `Bearer ${token}`,
  });
  if (r.status !== 200 || !r.data) return null;
  const u = (r.data && r.data.c_site_user) || {};
  const num = String(u.phone_number || '').trim();
  if (!num) return null;
  const cc = String(u.phone_country_code || '').trim();
  return { phone: cc ? `${cc}${num}` : num, countryCode: cc || '', verified: !!u.verified };
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

module.exports = {
  FILE, filePath, dataDir, load, save, list, get, findUsable, preferred,
  upsert, remove, patch, needsRefresh, exchange, jwtExp, fetchUserInfo,
  fetchPhone, maskPhone, genMachineId,
};
