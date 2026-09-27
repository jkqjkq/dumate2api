// src/qwenwork/login.js - 千问办公独立登录（OAuth Device Flow + PKCE）
//
// 这是「不再依赖官方客户端」的关键：客户端自己就是这么登录的（它的
// startDeviceFlow / pollDeviceToken，函数名在打包后未混淆），而我们能复现
// 整个流程——**取票端点不需要 Authorization**，持有 nonce + verifier 即可拿票。
//
// 流程：
//   1. 本地生成 PKCE（verifier + S256 challenge）与 nonce、machineId
//   2. 浏览器打开
//        https://gateway.qwenwork.cn/device/selectAccounts
//          ?challenge=<S256>&challenge_method=S256&nonce=<uuid>
//          &machine_id=<uuid>&client_id=<固定>&redirect_uri=qwenwork-cn://
//      → 302 到 https://qwenwork.cn/oauth2/auth（标准授权页），未登录再跳 /biz/signin
//   3. 授权结果由**服务端**记在 device flow 状态里，回调落
//      gateway.qwenwork.cn/oauth/callback —— 本机不需要监听端口
//   4. 轮询
//        https://gateway.qwenwork.cn/api/v1/deviceToken/poll
//          ?nonce=<uuid>&verifier=<pkce>&challenge_method=S256
//      pending → 404 {}；成功 → { device_token, refresh_token, expires_at, ... }
//
// 与 TRAE 的差别：TRAE 是「用户把回调地址粘回来」，这里是**服务端侧轮询**，
// 用户只需要完成浏览器里的登录，不必复制任何东西。
const crypto = require('crypto');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const c = require('./constants');
const authStore = require('./auth');

// 进行中的登录。key 是 nonce。
//
// **只放进程内**：登录窗口只有 5 分钟，而发起 start 与轮询的必然是同一个
// 前端会话（管理端那一个进程）。落盘反而要处理跨进程清理与残留。
const pending = new Map();

const TICK_MS = 60000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.at > c.DEVICE_FLOW_TIMEOUT_MS) pending.delete(k);
  }
}
const sweeper = setInterval(sweep, TICK_MS);
if (sweeper.unref) sweeper.unref(); // 不该拖住进程退出

/**
 * 客户端同款 PKCE：43~128 个 unreserved 字符，S256 后 base64url 去 padding。
 * 长度与字符集都要对——服务端会校验 challenge，不匹配直接 400。
 */
function generatePKCE() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const len = 43 + Math.floor(Math.random() * 86);
  const bytes = crypto.randomBytes(len);
  let verifier = '';
  for (let i = 0; i < len; i++) verifier += alphabet[bytes[i] % alphabet.length];
  const challenge = crypto.createHash('sha256').update(verifier).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

/** 开一次登录：返回给用户打开的授权地址 */
function startFlow() {
  sweep();
  const { verifier, challenge } = generatePKCE();
  const nonce = crypto.randomUUID();
  // 每个账号一份机器码：它与 token 配套进 wasm 签名，共用会让服务端
  // 把两个账号关联到同一台设备（TRAE 那边就是按设备限流的）
  const machineId = authStore.genMachineId();

  const q = new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: c.OAUTH_CLIENT_ID,
    redirect_uri: c.OAUTH_REDIRECT_URI,
  });

  pending.set(nonce, { verifier, challenge, machineId, at: Date.now() });
  return {
    ok: true,
    url: `${c.GATEWAY}${c.DEVICE_SELECT_PATH}?${q.toString()}`,
    nonce,
    machineId,
    hint: '在浏览器里打开上面的地址并登录目标账号。登录完成后浏览器会跳到 qwenwork-cn://（打不开是正常的），凭证由服务端保存，这里点「完成」即可。',
  };
}

/** 查一次取票端点 */
function fetchPoll(nonce, verifier) {
  return new Promise((resolve) => {
    const q = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' });
    const req = https.request({
      hostname: new URL(c.GATEWAY).hostname,
      path: `${c.DEVICE_POLL_PATH}?${q.toString()}`,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': c.USER_AGENT,
        'X-Request-Id': crypto.randomUUID(),
      },
      timeout: 20000,
    }, (res) => {
      let buf = '';
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
    req.end();
  });
}

/**
 * 轮询一次。返回 { status: 'pending' | 'ok' | 'error', ... }。
 *
 * 只查一次、不做等待——等待交给调用方（前端定时轮询 / 命令行自己 sleep），
 * 这样管理端接口能在 1 秒内返回，而不是把 HTTP 请求挂 5 分钟。
 */
async function pollFlow(nonce) {
  const st = pending.get(String(nonce || ''));
  if (!st) return { status: 'error', error: '登录已失效或不存在，请重新发起' };
  if (Date.now() - st.at > c.DEVICE_FLOW_TIMEOUT_MS) {
    pending.delete(nonce);
    return { status: 'error', error: '登录超时（5 分钟），请重新发起' };
  }

  const r = await fetchPoll(nonce, st.verifier);
  if (r.status === 404) return { status: 'pending', waited: Date.now() - st.at };
  if (r.status !== 200) {
    return { status: 'error', error: `取票失败 HTTP ${r.status} ${String(r.raw || '').slice(0, 160)}` };
  }
  const d = r.data || {};
  const token = d.token || d.device_token;
  if (!token) return { status: 'pending', waited: Date.now() - st.at };

  // 服务端会回显 nonce / challenge。确实回显了才比对——字段缺失时硬判
  // 不等会把一次正常登录报成失败（本版本回不回显不确定）
  if (d.nonce !== undefined && d.nonce !== nonce) {
    return { status: 'error', error: 'device flow 绑定校验失败（nonce 不一致）' };
  }
  if (d.code_challenge !== undefined && d.code_challenge !== st.challenge) {
    return { status: 'error', error: 'device flow 绑定校验失败（challenge 不一致）' };
  }
  if (!d.refresh_token) {
    return { status: 'error', error: '取票响应里没有 refresh_token，该账号后续无法续期' };
  }

  pending.delete(nonce);
  return finish({
    accessToken: token,
    refreshToken: d.refresh_token,
    expiresAt: authStore.jwtExp(token) || (d.expires_at ? Date.parse(d.expires_at) : null),
    refreshExpiresAt: d.refresh_token_expires_at ? Date.parse(d.refresh_token_expires_at) : null,
    machineId: st.machineId,
  });
}

/** 落盘一个新账号（补用户信息后写进账号池） */
async function finish(rec) {
  const info = await authStore.fetchUserInfo({ accessToken: rec.accessToken }) || {};
  // 手机号单独问一次 identities（account-context 里只有占位邮箱）。
  // 失败不阻断——没有手机号只是认号麻烦点，账号本身照样能用。
  let phone = null;
  try { phone = await authStore.fetchPhone({ accessToken: rec.accessToken }); } catch (e) { /* 忽略 */ }
  const saved = authStore.upsert({
    ...rec,
    uid: info.uid || rec.uid || '',
    nickname: info.nickname || '',
    username: info.username || '',
    email: info.email || '',
    tier: info.tier || '',
    planId: info.planId || '',
    planName: info.planName || '',
    phone: (phone && phone.phone) || '',
    lastError: '',
  });
  if (!saved.uid) {
    // uid 是 wasm 签名的必需输入。没有它就发不出请求，存下来也是个废账号——
    // 不如现在就说清楚，而不是等第一次请求失败才暴露
    return {
      status: 'error',
      error: '取到了 token 但读不到账号信息（account-context 失败），无法建立可用账号',
    };
  }
  return { status: 'ok', account: authStore.list().find((a) => a.id === saved.id) };
}

/** 取消一次进行中的登录 */
function cancelFlow(nonce) {
  return pending.delete(String(nonce || ''));
}

module.exports = { startFlow, pollFlow, finish, cancelFlow, generatePKCE, pending };
