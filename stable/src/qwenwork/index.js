// src/qwenwork/index.js - 千问办公通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道，不碰 wasm、
// DPAPI、COSY 签名的细节。
//
// 导出两个形态，与搭子路径的调用习惯对齐：
//   - chatCompletion(payload)  → 聚合后的 chat.completion 对象（非流式）
//   - chatCompletionStream(payload, onChunk) → 逐块回调 OpenAI chunk
const chat = require('./chat');
const bridge = require('./bridge');
const credentials = require('./credentials');
const constants = require('./constants');
const wasmPath = require('./wasm-path');

/** 预热：解析 wasm 路径。失败要早失败，别等到第一个请求才炸 */
function warmup() {
  return bridge.warmup();
}

/** 通道是否可用：wasm 找到 + 登录态能解出来 */
function status() {
  const w = wasmPath.resolveDetailed();
  let loggedIn = false;
  let error = '';
  try {
    const doc = chat.loadAuth();
    loggedIn = !!(doc && doc.token && doc.user && doc.user.id);
  } catch (e) {
    error = e.message;
  }
  return {
    ready: !!(w && loggedIn),
    wasm: w ? { file: w.file, version: w.version } : null,
    loggedIn,
    error: error || (w ? '' : 'wasm 未找到'),
  };
}

async function send(payload, onChunk) {
  const doc = await chat.ensureAuth();
  const modelKey = chat.resolveModelKey(payload && payload.model);
  const bodyJson = chat.buildBody(modelKey, payload);
  const built = bridge.prepareInfer({
    uid: doc.user.id,
    token: doc.token,
    bodyJson,
    modelKey,
    machineId: credentials.machineId(),
  });
  if (onChunk) {
    let firstErr = null;
    const res = await chat.postStream(built.url, built.body, built.headers, (inner) => {
      // 错误帧**不能**转给下游：一旦写进 SSE，客户端会把它当数据帧收下，
      // 而 HTTP 头早已发出（恒 200），改不成 4xx 了。
      // 所以先判错、判出错误就吞掉不转发，最后统一抛出去让上层回 4xx。
      if (firstErr) return;
      try {
        const err = chat.payloadError(JSON.parse(inner));
        if (err) { firstErr = err; return; }
      } catch (e) { /* 正常数据帧不是错误结构 */ }
      onChunk(inner);
    });
    if (firstErr) {
      const err = new Error(`qwenwork ${firstErr.code}: ${firstErr.message}`);
      err.statusCode = firstErr.code;
      throw err;
    }
    return res;
  }
  const res = await chat.post(built.url, built.body, built.headers);
  const es = chat.envelopeStatus(res.raw);
  if (es && es.code >= 400) {
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
  return chat.aggregate(payloads, modelKey);
}

/** 模型列表：优先问服务端，失败回落静态表 */
async function listModels() {
  try {
    const doc = await chat.ensureAuth();
    const built = bridge.prepareInfer({
      uid: doc.user.id,
      token: doc.token,
      bodyJson: '{}',
      modelKey: constants.DEFAULT_MODEL,
      machineId: credentials.machineId(),
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
      if (keys.length) return keys;
    }
  } catch (e) { /* 拿不到就用兜底，不阻断 */ }
  return constants.FALLBACK_MODELS.slice();
}

module.exports = { warmup, status, send, listModels, chatCompletion: (p) => send(p), chatCompletionStream: (p, cb) => send(p, cb) };
