// src/qwenwork/index.js - 千问办公通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道，不碰 wasm、
// 凭证、COSY 签名的细节。
//
// 凭证形态（2026-09-25 改）：以前只读官方客户端的 auth-v2.dat（单账号），
// 现在改成**自持凭证账号池**（data/qwenwork-accounts.json，见 auth.js），
// 与 TRAE Work 同构。选号是「指定主账号 + 故障时转移」。
//
// 导出两个形态，与搭子路径的调用习惯对齐：
//   - chatCompletion(payload)  → 聚合后的 chat.completion 对象（非流式）
//   - chatCompletionStream(payload, onChunk) → 逐块回调 OpenAI chunk
const chat = require('./chat');
const bridge = require('./bridge');
const authStore = require('./auth');
const constants = require('./constants');
const wasmPath = require('./wasm-path');
const credits = require('./credits');

// 在飞请求计数。积分归因在并发下有个本质限制：两个请求同时在飞时，
// 「前后差值」分不清是谁消耗的——总和正确，单项归属不准。
// 所以并发时如实标记 concurrent，而不是假装精确。
let inFlight = 0;

/** 预热：解析 wasm 路径。失败要早失败，别等到第一个请求才炸 */
function warmup() {
  return bridge.warmup();
}

/** 通道是否可用：wasm 找到 + 至少有一个可用账号 */
function status() {
  const w = wasmPath.resolveDetailed();
  const usable = authStore.findUsable();
  return {
    ready: !!(w && usable.length),
    wasm: w ? { file: w.file, version: w.version } : null,
    loggedIn: usable.length > 0,
    accounts: usable.length,
    error: !w ? 'wasm 未找到' : (usable.length ? '' : '尚未添加千问账号（需先登录一次）'),
  };
}

/**
 * 主账号。
 *
 * 顺序：preferred 标记 → 环境变量 DUMATE_QWENWORK_ACCOUNT → 第一个可用。
 * 由 authStore.preferred() 统一判定（那里也写了为什么是这个顺序）。
 */
function pickAccount() {
  const a = authStore.preferred();
  if (!a) throw new Error('千问办公没有可用账号，请先添加一个');
  return a;
}

/** 主账号失败时，下一个可试的账号（不含已试过的） */
function nextAccount(exclude) {
  const usable = authStore.findUsable();
  return usable.filter((a) => !exclude.has(a.id));
}

/**
 * 这个错误换账号还有救吗？
 *
 * 判据与 src/web-pool.js:266 同思路：4xx（除 401/402/429/403-模型不可用）是
 * 请求本身的问题，换账号也只是再失败一次，白白把每个账号都试一遍还放大延迟。
 *
 * **只按数字 code 判，绝不匹配 message**：402（额度耗尽）与 400（请求格式错）
 * 的 message 完全相同（都是 "Error in upstream response"），按 message 判会把
 * 「请求格式错」误判成「额度耗尽」，从而对全池空转一遍。
 */
function retryable(code, message) {
  const n = Number(code);
  if (!Number.isFinite(n) || n === 0) return true; // 网络错误/异常：换号试一次
  if (n === 401 || n === 402 || n === 429) return true;
  if (n === 403) {
    // 403 不能一刀切：实测那条是 "Model is not available for this user"——
    // 这是**账号维度**的（模型对该账号不可用），换账号恰恰是正确处置。
    // 其余 403（签名/权限类）换号也一样失败。
    return /not available for this user|not available|无权限|无权访问/i.test(String(message || ''));
  }
  if (n >= 500) return true; // 上游抖动，换号可能落到别的实例
  return false;
}

/** 把一次失败记到账号上（界面要能看到为什么这个号没被用） */
function markFailure(account, msg) {
  try { authStore.patch(account.id, { lastError: String(msg).slice(0, 200) }); }
  catch (e) { /* 记不下不影响主流程 */ }
}

/**
 * 用指定账号跑一次请求（非流式 / 流式由 onChunk 决定）。
 *
 * @returns {Promise<object>} 非流式返回 chat.completion；流式返回 { streamed:true }
 */
async function runOnce(account, payload, onChunk, opts) {
  const auth = await chat.ensureAccount(authStore, account);
  const modelKey = chat.resolveModelKey(payload && payload.model);
  const bodyJson = chat.buildBody(modelKey, payload);
  const built = bridge.prepareInfer({
    uid: auth.uid,
    token: auth.accessToken,
    bodyJson,
    modelKey,
    // machineId 与 token 配套：登录时生成并存在账号记录里，不能用全局那份
    machineId: auth.machineId || '',
  });

  const startedAt = Date.now();
  const wasConcurrent = inFlight > 0;
  inFlight++;
  const settle = () => {
    inFlight = Math.max(0, inFlight - 1);
    // reqId 由调用方（server.js）生成，与请求埋点同源：归因要等结算，
    // 时间戳对不上，只有这个键能把两边精确配对
    credits.capture({
      account: auth,
      model: modelKey,
      startedAt,
      reqId: opts.reqId,
      concurrent: wasConcurrent,
    }).catch(() => { /* 采集失败绝不影响已发出的响应 */ });
  };

  try {
    if (onChunk) {
      let firstErr = null;
      let sent = false; // 是否已向下游发过帧——发了就不能再换账号了
      const res = await chat.postStream(built.url, built.body, built.headers, (inner) => {
        // 错误帧**不能**转给下游：一旦写进 SSE，客户端会把它当数据帧收下，
        // 而 HTTP 头早已发出（恒 200），改不成 4xx 了。
        // 所以先判错、判出错误就吞掉不转发，最后统一抛出去让上层回 4xx。
        if (firstErr) return;
        try {
          const err = chat.payloadError(JSON.parse(inner));
          if (err) { firstErr = err; return; }
        } catch (e) { /* 正常数据帧不是错误结构 */ }
        sent = true;
        onChunk(inner);
      });
      settle();
      if (firstErr) {
        const err = new Error(`qwenwork ${firstErr.code}: ${firstErr.message}`);
        err.statusCode = firstErr.code;
        // 已经吐过帧的流不能再换账号重来——客户端收到了半截输出
        err.sent = sent;
        throw err;
      }
      return res;
    }
    const res = await chat.post(built.url, built.body, built.headers);
    const es = chat.envelopeStatus(res.raw);
    if (es && es.code >= 400) {
      settle();
      const err = new Error(`qwenwork ${es.code}: ${es.message}`);
      err.statusCode = es.code;
      throw err;
    }
    const payloads = [];
    for (const line of String(res.raw || '').split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;
      payloads.push(...chat.unwrap(raw));
    }
    settle();
    return chat.aggregate(payloads, modelKey);
  } catch (e) {
    // post/postStream 自己抛的是网络错误，也要收尾，否则 inFlight 会一直涨
    if (!e.statusCode) settle();
    throw e;
  }
}

/**
 * 一次请求最多试几个账号。
 *
 * 夹住是因为 prepareInfer 走 execFileSync（bridge.js:46）——它**阻塞整个 Node
 * 事件循环**，一次签名要独占进程几百毫秒（起 Node + 实例化 289KB wasm），
 * 期间搭子链路的请求也一起卡住。无上限重试会把搭子主链路拖垮。
 * 另有 3 次上限，但受可用账号数夹逼（只有 1 个账号时不做任何重试）。
 */
const MAX_ATTEMPTS = 3;

/**
 * 发对话请求。主账号失败且错误「换号有救」时，按可用列表顺序转移。
 *
 * 每个账号只试一次，不重复试同一个：同一账号连着失败两次几乎必然还是失败，
 * 而重试要重新签名（execFileSync），代价不小。
 *
 * bodyJson 在 runOnce 里按账号构造（签名需要该账号的 uid/token/machineId）。
 */
async function send(payload, onChunk, opts = {}) {
  const tried = new Set();
  const errors = [];
  let account = pickAccount();

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    tried.add(account.id);
    // 多账号下「这次实际用了哪个」只有这里知道，由 provider 上报给埋点。
    // 在别处猜（比如「池里的第一个」）在转移场景下必然记错。
    if (opts.onAccount) {
      const name = account.nickname || account.uid || `账号 ${account.id}`;
      try { opts.onAccount(name); } catch (e) { /* 上报失败不影响请求 */ }
    }

    try {
      return await runOnce(account, payload, onChunk, opts);
    } catch (e) {
      const code = Number(e.statusCode) || 0;
      markFailure(account, e.message);
      errors.push({ account: account.nickname || account.uid || account.id, status: code || '-', error: e.message });
      // 流式已经吐过帧，客户端收到了半截输出，再换号会输出两遍
      if (e.sent) throw e;
      if (!retryable(code, e.message)) throw e;
      const rest = nextAccount(tried);
      if (!rest.length) break;
      account = rest[0];
    }
  }

  const err = new Error(`千问办公所有账号均失败：${errors.map((x) => `${x.account}(${x.status})`).join('；')}`);
  err.statusCode = Number(errors[errors.length - 1].status) || 502;
  throw err;
}

/** 模型列表：优先问服务端，失败回落静态表。用选中账号的凭证 */
async function listModels() {
  try {
    const account = await chat.ensureAccount(authStore, pickAccount());
    const built = bridge.prepareInfer({
      uid: account.uid,
      token: account.accessToken,
      bodyJson: '{}',
      modelKey: constants.DEFAULT_MODEL,
      machineId: account.machineId || '',
    });
    const u = new URL(constants.GATEWAY);
    const res = await new Promise((resolve, reject) => {
      const req = require('https').request({
        hostname: u.hostname,
        path: constants.MODELS_PATH,
        method: 'GET',
        headers: { ...built.headers, 'Accept': 'application/json' },
        timeout: 20000,
      }, (r) => {
        let b = '';
        r.on('data', (c) => { b += c; });
        r.on('end', () => resolve({ status: r.statusCode, raw: b }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('models timeout')));
      req.end();
    });
    if (res.status === 200) {
      const j = JSON.parse(res.raw);
      const keys = ((j && j.qwork) || []).filter((m) => m && m.enable !== false).map((m) => m.key);
      if (keys.length) {
        // 成功拉到就告诉 model-info：界面据此把上下文等字段标成「上游下发」，
        // 而不是回落静态表（两者可信度不同）
        try { require('../model-info').setQwenKeys(keys); } catch (e) { /* 不影响返回 */ }
        return keys;
      }
    }
  } catch (e) { /* 拿不到就用兜底，不阻断 */ }
  return constants.FALLBACK_MODELS.slice();
}

module.exports = {
  warmup, status, send, listModels, pickAccount,
  chatCompletion: (p, opts) => send(p, undefined, opts),
  chatCompletionStream: (p, cb, opts) => send(p, cb, opts),
};
