// probe-qwen-device-login.js - 千问办公「独立登录」可行性探针
//
// 要回答的问题：不打开千问办公客户端、也不读写它的 auth-v2.dat，
// 能否自己拿到一份可用的千问凭证？能，则千问通道就能做真正的多账号池。
//
// 流程逆向自 QwenWorkCN 1.2.0 的 app.asar/out/main/main.js
// （startDeviceFlow / pollDeviceToken，函数名在打包后未混淆）：
//
//   1. 本地生成 PKCE（verifier + S256 challenge）与 nonce
//   2. 浏览器打开
//        https://gateway.qwenwork.cn/device/selectAccounts
//          ?challenge=<S256>&challenge_method=S256&nonce=<uuid>
//          &machine_id=<uuid>&client_id=<固定>&redirect_uri=qwenwork-cn://
//      → 302 到 https://qwenwork.cn/oauth2/auth?...（标准 OAuth 授权页）
//      → 未登录再 302 到 /biz/signin，登录后回到授权页
//   3. 授权结果由**服务端**记在 device flow 状态里（回调落在
//      gateway.qwenwork.cn/oauth/callback，不需要本机监听端口）
//   4. 客户端轮询
//        https://gateway.qwenwork.cn/api/v1/deviceToken/poll
//          ?nonce=<uuid>&verifier=<pkce>&challenge_method=S256
//      pending 时返回 404 + {}；成功后返回 { device_token, refresh_token, ... }
//
// 关键点：**poll 端点不需要 Authorization**。持有 nonce+verifier 即可取票，
// 所以这套流程可以完全脱离客户端跑在网关上。
//
// 用法：
//   node probe-qwen-device-login.js          # 开独立浏览器窗口，登录后自动取票
//   node probe-qwen-device-login.js --url    # 只打印授权 URL（用系统浏览器打开）
//   node probe-qwen-device-login.js --machine=<uuid>   # 指定 machine_id
//
// **只读探针**：拿到凭证后只打印账号信息与余额，不写任何文件。
// 落盘要显式加 --save（走 authStore.upsert，写进 data/qwenwork-accounts.json）。
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const authStore = require('./src/qwenwork/auth');

const GATEWAY = 'gateway.qwenwork.cn';
const CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'; // QWENWORK_CN_CLIENT_ID
const REDIRECT = 'qwenwork-cn://';
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 300000; // 客户端也是 5 分钟

// 与 constants.js 保持一致；取值不同只影响请求头声明，不影响本探针结论
const UA_HEADERS = {
  'X-QwenWork-Version': '1.1.0',
  'X-QwenWork-Release-Version': '1.1.0-26091701',
  'X-QwenWork-Build': '26091701',
  'X-QwenWork-Platform': 'x86_64_win32',
  'X-QwenWork-Arch': 'x64',
  'X-QwenWork-Channel': 'stable',
};

/** 客户端的 PKCE：43~128 个 unreserved 字符，S256 后 base64url 去 padding */
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

/** 读客户端机器的 machine_id；没有就生成一个 */
function machineId(explicit) {
  if (explicit) return explicit;
  const f = path.join(process.env.USERPROFILE || process.env.HOME || '', '.qoderworkcn', '.auth', 'machine_id');
  try {
    const v = fs.readFileSync(f, 'utf8').trim();
    if (v) return v;
  } catch (e) { /* 没装客户端也能跑 */ }
  return crypto.randomUUID();
}

function buildAuthUrl({ challenge, nonce, machineId }) {
  const q = new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
  });
  return `https://${GATEWAY}/device/selectAccounts?${q.toString()}`;
}

function httpGetJson(pathname, token) {
  return new Promise((resolve) => {
    const headers = { Accept: 'application/json', 'User-Agent': 'qoderwork/1.1.0', ...UA_HEADERS };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = https.request({ hostname: GATEWAY, path: pathname, method: 'GET', headers, timeout: 20000 }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => {
        let data = null;
        try { data = JSON.parse(b); } catch (e) { /* 非 JSON */ }
        resolve({ status: r.statusCode, data, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

/** 轮询取票。pending → 404；成功 → 200 + { device_token, refresh_token } */
async function poll({ nonce, verifier, onTick }) {
  const q = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' });
  const startedAt = Date.now();
  let tick = 0;
  let fails = 0;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const r = await httpGetJson(`/api/v1/deviceToken/poll?${q.toString()}`);
    if (r.status === 404) {
      if (onTick && ++tick % 5 === 0) onTick(Math.round((Date.now() - startedAt) / 1000));
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (r.status !== 200) {
      if (++fails >= 5) return { ok: false, error: `poll HTTP ${r.status} ${String(r.raw).slice(0, 200)}` };
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    fails = 0;
    const d = r.data || {};
    if (!d.token && !d.device_token) { await sleep(POLL_INTERVAL_MS); continue; }
    // 客户端会校验服务端回显的绑定字段，这里照做——防中间人替换凭证。
    // 只在服务端**确实回显了**该字段时才比对：字段缺失说明本版本不回显，
    // 此时硬判不等会把一次正常登录报成失败。
    if (d.nonce !== undefined && d.nonce !== nonce) {
      return { ok: false, error: `device flow 绑定校验失败（nonce 不回显一致：${d.nonce}）` };
    }
    if (d.code_challenge !== undefined && d.code_challenge !== challengeOf(verifier)) {
      return { ok: false, error: 'device flow 绑定校验失败（challenge 不匹配）' };
    }
    return { ok: true, tokens: d };
  }
  return { ok: false, error: 'device flow 超时（5 分钟内未完成授权）' };
}

function challengeOf(verifier) {
  return crypto.createHash('sha256').update(verifier).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

/** 用拿到的 token 打印账号与余额——这是「凭证真的可用」的证据 */
async function inspect(token) {
  const ctx = await httpGetJson('/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing', token);
  const u = (ctx.data && ctx.data.data && ctx.data.data.user) || null;
  const plan = (ctx.data && ctx.data.data && ctx.data.data.plan) || null;
  console.log('\n=== 账号（account-context）===');
  console.log('用户名 :', u ? u.name : '(取不到)');
  console.log('uid    :', u ? u.id : '');
  console.log('套餐   :', plan ? `${plan.name} (${plan.pid})` : '');
  console.log('企业   :', u && u.is_biz ? '是' : '否');

  // 余额走网页站点接口，与 src/qwenwork/credits.js 同一套
  const w = await new Promise((resolve) => {
    const req = https.request({
      hostname: 'qwenwork.cn', path: '/user/wallets', method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'qoderwork/1.1.0' },
      timeout: 15000,
    }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
  console.log('\n=== 积分（user/wallets）===');
  if (!w || !w.data) {
    console.log('取不到（HTTP 层可能有 401，凭证仍可能是好的）');
  } else {
    const d = w.data;
    const n = (x) => (x && typeof x.total_balance === 'number' ? x.total_balance : '—');
    console.log('每日额度 :', n(d.daily_credits));
    console.log('月度积分 :', n(d.monthly_credits));
    console.log('长期积分 :', n(d.longterm_credits));
  }
  return { u, plan };
}

function findBrowser() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  if (process.env.DUMATE_BROWSER_PATH && fs.existsSync(process.env.DUMATE_BROWSER_PATH)) {
    return process.env.DUMATE_BROWSER_PATH;
  }
  for (const p of cands) if (fs.existsSync(p)) return p;
  return null;
}

(async () => {
  const args = process.argv.slice(2);
  const urlOnly = args.includes('--url');
  const explicitMachine = (args.find((a) => a.startsWith('--machine=')) || '').split('=')[1];

  const { verifier, challenge } = generatePKCE();
  const nonce = crypto.randomUUID();
  const mid = machineId(explicitMachine);
  const authUrl = buildAuthUrl({ challenge, nonce, machineId: mid });

  console.log('=== 千问办公 Device Flow 探针 ===');
  console.log('machine_id :', mid);
  console.log('nonce      :', nonce);
  console.log('\n请用【尚未在客户端登录过的那个账号】完成授权：\n');
  console.log(authUrl);
  console.log('');

  let closeBrowser = async () => {};
  if (urlOnly) {
    console.log('（--url 模式：请手动在浏览器打开上面的地址）');
  } else {
    const exe = findBrowser();
    if (!exe) {
      console.log('未找到 Edge/Chrome，退回手动模式。请自行打开上面的地址。');
    } else {
      // 独立窗口 + 全新 profile：不碰用户已有浏览器的登录态。
      // 复用固定 profile 会让「上次登录的账号」被直接带进来，测不出换账号。
      const { chromium } = require('playwright-core');
      const ctx = await chromium.launch({ executablePath: exe, headless: false, args: ['--no-first-run', '--no-default-browser-check'] });
      const page = await ctx.newPage();
      await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      closeBrowser = () => ctx.close().catch(() => {});
      console.log('已打开独立浏览器窗口（全新 profile），请在其中登录目标账号。');
    }
  }

  const r = await poll({ nonce, verifier, onTick: (s) => console.log(`  等待中… ${s}s`) });
  if (!r.ok) {
    console.log('\n✗ ' + r.error);
    await closeBrowser();
    process.exit(1);
  }

  const t = r.tokens;
  const token = t.token || t.device_token;
  console.log('\n✓ 拿到凭证');
  console.log('  access token 前 20 :', String(token).slice(0, 20) + '…');
  console.log('  refresh token 前 16:', String(t.refresh_token || '').slice(0, 16) + '…');
  console.log('  expires_at         :', t.expires_at || '—');
  console.log('  refresh 过期        :', t.refresh_token_expires_at || '—');
  console.log('\n  ※ 只打印，不落盘。');

  const info = await inspect(token);
  await closeBrowser();

  const wantSave = args.includes('--save');
  const wantPreferred = args.includes('--preferred');
  if (!wantSave) {
    console.log('\n  ※ 只打印，不落盘。加 --save 才会写进账号池。');
    console.log('\n探针结束。');
    return;
  }

  // ---- 落盘 ----
  const rec = {
    accessToken: token,
    refreshToken: t.refresh_token || '',
    expiresAt: authStore.jwtExp(token) || (t.expires_at ? Date.parse(t.expires_at) : null),
    refreshExpiresAt: t.refresh_token_expires_at ? Date.parse(t.refresh_token_expires_at) : null,
    machineId: mid,
    uid: (info && info.u && info.u.id) || '',
    // 名字与套餐来自上面 inspect() 已经读到的 account-context。
    // 不填的话凭证虽然能用（uid 有就能签名），但管理端账号列表的
    // 昵称/套餐两列会是空白——看不出这个号是谁。
    nickname: (info && info.u && (info.u.name || info.u.username)) || '',
    username: (info && info.u && info.u.username) || '',
    email: (info && info.u && info.u.email) || '',
    tier: (info && info.plan && info.plan.name) || ((info && info.u && info.u.tier) || ''),
    planId: (info && info.plan && info.plan.pid) || '',
    planName: (info && info.plan && info.plan.name) || '',
    lastError: '',
  };
  if (wantPreferred) rec.preferred = true;
  const saved = authStore.upsert(rec);
  console.log('\n✓ 已写入账号池:', authStore.filePath());
  console.log('  id       :', saved.id);
  console.log('  uid      :', saved.uid || '(空)');
  console.log('  preferred:', !!saved.preferred);
  console.log('  machineId:', saved.machineId);

  // ---- 真实推理验证（最关键的一步）----
  //
  // 前面所有步骤（登录/取票/account-context/wallets）都没碰过数据面。
  // 而 wasm 签名用的是 uid + token + machineId，服务端会不会校验
  // 「签名用的 machine_id 必须等于登录时上报的那个」**还没实测过**。
  // 这一炮打不通，整套多账号方案就是空谈——所以必须打。
  if (!saved.uid) {
    console.log('\n✗ 没有 uid，无法验证推理（wasm 签名必需）');
    return;
  }
  console.log('\n=== 真实推理验证（用刚登录的账号）===');
  try {
    const qw = require('./src/qwenwork');
    const out = await qw.send(
      { model: 'flash', messages: [{ role: 'user', content: '说一个字：好' }], max_tokens: 64 },
      undefined,
      {},
    );
    const msg = (out.choices && out.choices[0] && out.choices[0].message) || {};
    console.log('✓ 推理成功');
    console.log('  正文   :', JSON.stringify(String(msg.content || '').slice(0, 60)));
    console.log('  finish :', out.choices && out.choices[0] && out.choices[0].finish_reason);
    console.log('  usage  :', JSON.stringify(out.usage || {}));
  } catch (e) {
    console.log('✗ 推理失败:', e.message);
    console.log('  （若 401/403：服务端在校验 machine_id 与登录时的一致性；');
    console.log('    若 402：这个账号额度也耗尽了，换一个号再试）');
  }
  console.log('\n探针结束。');
})().catch((e) => {
  console.error('探针异常：', e && e.message);
  process.exit(1);
});
