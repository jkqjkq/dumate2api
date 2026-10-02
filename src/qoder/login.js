// src/qoder/login.js - Qoder 独立登录（OAuth Device Flow + PKCE）
//
// 与千问办公**完全同一套流程**（连 client_id 都相同——同一平台的两个产品），
// 所以实现可以照搬 qwenwork/login.js 的结构。
//
// 流程：
//   1. 本地生成 PKCE（verifier + S256 challenge）与 nonce
//   2. 浏览器打开
//        https://qoder.com.cn/device/selectAccounts
//          ?nonce=<uuid>&challenge=<S256>&challenge_method=S256&client_id=<固定>
//      → 未登录会 302 到 /users/sign-in
//   3. 授权结果由**服务端**记在 device flow 状态里，本机不需要监听端口
//   4. 轮询
//        https://openapi.qoder.com.cn/api/v1/deviceToken/poll
//          ?nonce=<uuid>&verifier=<pkce>&challenge_method=S256
//      pending → 404；成功 → { token: "dt-xxx", refresh_token: "drt-xxx", ... }
//
// **不需要装 Qoder 客户端**——取票端点不需要 Authorization，持有 nonce + verifier
// 即可拿票。这是本通道比千问更干净的地方（千问签名还要 wasm）。
const crypto = require('crypto');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const c = require('./constants');
const authStore = require('./auth');
const session = require('./session');

// 进行中的登录。key 是 nonce。**只放进程内**——登录窗口 5 分钟，
// 发起与轮询必然是同一个前端会话，落盘反而要处理跨进程清理。
const pending = new Map();
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

const TICK_MS = 60000;
function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > FLOW_TIMEOUT_MS) pending.delete(k);
}
const sweeper = setInterval(sweep, TICK_MS);
if (sweeper.unref) sweeper.unref();

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
function startFlow(region) {
  sweep();
  const reg = c.normalizeRegion(region);
  const { verifier, challenge } = generatePKCE();
  const nonce = crypto.randomUUID();
  const q = new URLSearchParams({
    nonce,
    challenge,
    challenge_method: 'S256',
    client_id: c.OAUTH_CLIENT_ID,
  });
  pending.set(nonce, { verifier, challenge, region: reg, at: Date.now() });
  const ep = c.endpointsOf(reg);
  return {
    ok: true,
    url: `${ep.DeviceLoginBase}?${q.toString()}`,
    nonce,
    region: reg,
    hint: '在浏览器里打开上面的地址并登录目标账号。登录完成后浏览器会跳到 qoder-cn://（打不开是正常的），凭证由服务端保存，这里点「完成」即可。',
  };
}

/** 查一次取票端点 */
function fetchPoll(region, nonce, verifier) {
  const ep = c.endpointsOf(region);
  return new Promise((resolve) => {
    const q = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' });
    const u = new URL(ep.PollEndpoint);
    const req = https.request({
      hostname: u.hostname,
      path: `${u.pathname}?${q.toString()}`,
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'qoder/1.0.0' },
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
 * 只查一次、不做等待——等待交给调用方，这样管理端接口能在 1 秒内返回。
 */
async function pollFlow(nonce) {
  const st = pending.get(String(nonce || ''));
  if (!st) return { status: 'error', error: '登录已失效或不存在，请重新发起' };
  if (Date.now() - st.at > FLOW_TIMEOUT_MS) {
    pending.delete(nonce);
    return { status: 'error', error: '登录超时（5 分钟），请重新发起' };
  }

  const r = await fetchPoll(st.region, nonce, st.verifier);
  if (r.status === 404) return { status: 'pending', waited: Date.now() - st.at };
  if (r.status !== 200) {
    return { status: 'error', error: `取票失败 HTTP ${r.status} ${String(r.raw || '').slice(0, 160)}` };
  }
  const d = r.data || {};
  const token = d.token || d.device_token;
  if (!token) return { status: 'pending', waited: Date.now() - st.at };
  if (!d.refresh_token) {
    return { status: 'error', error: '取票响应里没有 refresh_token，该账号后续无法续期' };
  }

  pending.delete(nonce);
  return finish({
    accessToken: token,
    refreshToken: d.refresh_token,
    expiresAt: d.expires_at ? Date.parse(d.expires_at) : null,
    refreshExpiresAt: d.refresh_token_expires_at ? Date.parse(d.refresh_token_expires_at) : null,
    region: st.region,
  });
}

/**
 * 落盘一个新账号（补用户信息后写进账号池）。
 *
 * machineId / machineToken / machineType 每个账号一份：它们进 COSY 签名的
 * `cosy-machineid` 等头。Qoder 的 device flow **不像千问那样在授权链接里绑定
 * machine_id**，所以可以自由生成并持久化（生成后不再改，改了等于换设备）。
 */
async function finish(rec) {
  const region = c.normalizeRegion(rec.region);
  const info = await session.fetchUserInfo(rec.accessToken, region);
  if (!info || !info.id) {
    return { status: 'error', error: '取到了 token 但读不到账号信息（userinfo 失败），无法建立可用账号' };
  }
  const plan = await session.fetchPlan(rec.accessToken, region).catch(() => null);
  const saved = authStore.upsert({
    ...rec,
    region,
    uid: info.id,
    nickname: info.name || '',
    username: info.username || '',
    email: info.email || '',
    userType: (plan && plan.user_type) || info.user_type || '',
    planName: (plan && plan.plan_tier_name) || '',
    machineId: rec.machineId || crypto.randomUUID(),
    machineToken: rec.machineToken || crypto.randomBytes(38).toString('base64url').slice(0, 50),
    machineType: rec.machineType || crypto.randomBytes(9).toString('hex'),
    lastError: '',
    lastErrorAt: null,
  });
  return { status: 'ok', account: authStore.list().find((a) => a.id === saved.id) };
}

function cancelFlow(nonce) {
  return pending.delete(String(nonce || ''));
}

module.exports = { startFlow, pollFlow, finish, cancelFlow, generatePKCE, pending };
