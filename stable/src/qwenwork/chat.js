// src/qwenwork/chat.js - 千问办公数据面客户端
//
// 链路：构造 OpenAI 风格 body → 官方 wasm 封装（Encode=1）→ POST 网关 →
// 剥外层信封（data:{"body":"<内层 chunk>"}）→ 得到标准 OpenAI 响应。
//
// 与搭子（8980）的关键差异，改动前请先看这里：
//   1. 外层永远 HTTP 200，真实状态在信封的 statusCodeValue 里。
//      不剥信封会把 503 当 200 转发出去，客户端永远看不出失败。
//   2. 模型名走 body 里的 chat_context.extra.modelConfig.key 与
//      model_config.key，不是顶层 model。
//   3. 必须带 business 对象，否则 503 Model catalog unavailable。
//   4. 推理与正文分开流（reasoning_content 先到、content 后到），
//      与搭子「抢同一 max_tokens」的机制不同。
const https = require('https');
const crypto = require('crypto');
const constants = require('./constants');
const credentials = require('./credentials');
const bridge = require('./bridge');

const TIMEOUT_MS = 600000;

let authCache = null; // { at, doc } —— 解密要起 PowerShell，别每请求都做
const AUTH_TTL_MS = 60000;

function loadAuth(force = false) {
  if (!force && authCache && Date.now() - authCache.at < AUTH_TTL_MS) return authCache.doc;
  const doc = credentials.decryptAuth();
  authCache = { at: Date.now(), doc };
  return doc;
}

function resolveModelKey(name) {
  const raw = String(name || '').trim() || constants.DEFAULT_MODEL;
  return constants.MODEL_ALIASES[raw] || raw;
}

function buildBody(modelKey, payload) {
  const requestId = crypto.randomUUID();
  const sessionId = (payload && payload.session_id) || crypto.randomUUID();
  const messages = (payload && payload.messages) || [];
  let system = '';
  if (payload && typeof payload.system === 'string') system = payload.system;
  const sysMsg = messages.find((m) => m && m.role === 'system');
  if (!system && sysMsg) system = String(sysMsg.content || '');
  // **不要把 system 从 messages 里摘出去**：实测上游只认 messages 里的
  // system 角色，顶层的 `system` 字段它根本不读。摘出去会让系统提示词
  // 整体丢失——模型收不到任何指令，表现为「不按要求做事、随口答两句就停」。
  // 顶层字段仍然带上（兼容），但权威来源是 messages。
  const turns = messages;
  const lastUser = [...turns].reverse().find((m) => m && m.role === 'user');
  const text = lastUser ? String(lastUser.content || '') : '';

  const parameters = {};
  for (const k of ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']) {
    if (payload && payload[k] != null) parameters[k] = payload[k];
  }
  if (parameters.max_tokens == null) parameters.max_tokens = 32000;

  // 工具定义必须透传：硬编码空数组会让模型看不到工具，
  // 于是把工具调用当**文本**输出（Codex 里表现为 `<tool_call>` 原样打印、不执行）。
  //
  // 但**必须过滤上游不认识的结构**：实测千问上游只接受标准 OpenAI 形状
  // （`{type:"function", function:{...}}`）。Codex 会额外发送：
  //   - `namespace`（multi_agent_v1 / mcp__cua_repl 等工具组）
  //   - `web_search`（内置搜索）
  // 只要带上其中任何一个，**整个请求直接 400**（Error in upstream response），
  // 不是丢弃那个工具而是整轮失败——表现为 Codex 里模型反复重试、任务卡死。
  // 所以这里只保留 function 类型，其余静默丢弃（Codex 侧有 fallback）。
  const rawTools = Array.isArray(payload && payload.tools) ? payload.tools : [];
  const tools = rawTools.filter((t) => t && t.type === 'function' && t.function && t.function.name);
  // tool_choice 只在确实还有工具时才带；没有工具时带上会被上游拒
  const toolChoice = tools.length ? (payload && payload.tool_choice) : null;

  return JSON.stringify({
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true, // 上游只走 SSE；非流式由本文件聚合
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: false },
        originalContent: text,
        chatPrompt: '',
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qoder_work',
    aliyun_user_type: '',
    model_config: {
      key: modelKey,
      display_name: modelKey,
      model: '',
      format: 'openai',
      is_vl: modelKey === 'pro' || modelKey === 'flash',
      is_reasoning: false,
      api_key: '',
      url: '',
      source: 'system',
      // 实测得出的上下文上限（2026-09-24，中文输入，逐档上探 + 二分定位）：
      //   1250K 汉字 → 1,022,745 token  通过
      //   1262K 汉字 → 502；1300K 汉字 → 400
      // pro 与 flash 边界一致。原来写 1000000 是拍脑袋的值，实际能到 ~1.02M，
      // 且超过 1M 之后不是"截断"而是直接整轮失败（400/502），
      // 所以这里如实填实测值，别让上游按一个错误的声明去硬拒。
      max_input_tokens: 1024000,
    },
    // 没有这个字段服务端一律 503 Model catalog unavailable，
    // 且它与签名无关——抓到的桌面流量总是带它。
    business: {
      product: constants.BUSINESS_PRODUCT,
      version: constants.COSY_VERSION,
      type: constants.BUSINESS_TYPE,
      id: crypto.randomUUID(),
      name: '',
      begin_at: Date.now(),
      stage: 'processing',
    },
    system,
    messages: turns,
    tools,
    ...(toolChoice != null ? { tool_choice: toolChoice } : {}),
    parameters,
  });
}

/** 剥外层信封：返回内层 OpenAI SSE payload 数组 */
function unwrap(raw) {
  const text = String(raw || '').trim();
  if (!text || text === '[DONE]' || text === '{}') return [];
  let outer;
  try { outer = JSON.parse(text); } catch (e) { return [text]; }
  if (!outer || typeof outer !== 'object') return [];
  if (outer.choices || outer.object === 'chat.completion.chunk' || outer.object === 'chat.completion') {
    return [text];
  }
  const inner = outer.body;
  if (inner == null) return [];
  if (typeof inner === 'object') {
    const dumped = JSON.stringify(inner);
    return dumped === '{}' || dumped === '[]' ? [] : [dumped];
  }
  const s = String(inner).trim();
  if (!s || s === '[DONE]' || s === '{}' || s === 'null') return [];
  return [s];
}

/**
 * 从内层 payload 判定是否是错误。
 *
 * 千问的错误有两种落地形态，都实测过：
 *   - 信封层：{statusCodeValue: 403, statusCode: "Forbidden", body: "{\"code\":\"403\",...}"}
 *   - 内层层：{"code":"403","message":"Model is not available for this user"}
 * 流式路径拿到的是**剥过信封的内层**，所以不能只看 statusCodeValue。
 *
 * 不判这个的后果是静默失败：上游报 403，客户端却收到 200 + 空 content +
 * finish_reason=stop，看起来像「模型不想回答」，实际是调用被拒。
 */
function payloadError(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const code = obj.code != null ? Number(obj.code) : null;
  if (code && code >= 400) {
    return { code, message: String(obj.message || obj.error || '') };
  }
  // 有些错误把 code 放在 status 里（如 "Forbidden"），或只有 message
  if (typeof obj.code === 'string' && /^[A-Z]/.test(obj.code) && obj.message) {
    return { code: 500, message: `${obj.code}: ${obj.message}` };
  }
  return null;
}

/** 信封里的业务错误码（外层 HTTP 恒为 200，且可能带 data: 前缀） */
function envelopeStatus(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  // 响应体是一行行 `data:<json>`（不是裸 JSON）。早期版本直接 JSON.parse
  // 整段，前缀让解析必然失败、异常被吞成 null，于是**所有信封错误都被
  // 静默成成功**。这里逐行剥前缀。
  const candidates = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const json = t.startsWith('data:') ? t.slice(5).trim() : t;
    if (!json || json === '[DONE]') continue;
    try { candidates.push(JSON.parse(json)); } catch (e) { /* 非 JSON 行 */ }
  }
  for (const outer of candidates) {
    if (!outer || typeof outer !== 'object') continue;
    const code = outer.statusCodeValue != null ? Number(outer.statusCodeValue) : null;
    if (code && code >= 400) {
      let message = '';
      try {
        const inner = typeof outer.body === 'string' ? JSON.parse(outer.body) : outer.body;
        message = (inner && (inner.message || inner.error)) || '';
      } catch (e) { message = String(outer.body || '').slice(0, 200); }
      return { code, message };
    }
    // 也检查内层（信封 statusCodeValue 为 200 但内层带 code 的情况）
    try {
      const inner = typeof outer.body === 'string' ? JSON.parse(outer.body) : outer.body;
      const err = payloadError(inner);
      if (err) return err;
    } catch (e) { /* 内层不是 JSON */ }
  }
  return null;
}

/** 发一次推理请求，返回 { status, headers, raw } */
function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Accept': 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      // 同 postStream：必须用 StringDecoder 保持跨 chunk 的解码状态，
      // 否则非流式响应里的汉字也会在 chunk 边界处变成 U+FFFD
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (c) => { buf += dec.write(c); });
      res.on('end', () => { buf += dec.end(); resolve({ status: res.statusCode, headers: res.headers, raw: buf }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('qwenwork upstream timeout')); });
    req.write(body);
    req.end();
  });
}

/** 流式：逐块回调内层 payload（含 [DONE]） */
function postStream(url, body, headers, onChunk) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Accept': 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      // **必须用 StringDecoder**：TCP chunk 不按字符边界切，
      // 直接 `c.toString('utf8')` 会让跨 chunk 的多字节汉字被截成 U+FFFD，
      // 表现为流式输出里随机出现「�」。StringDecoder 会缓存半个字符等下一块。
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      const flushLine = (line) => {
        const t = line.trim();
        if (!t.startsWith('data:')) return;
        const raw = t.slice(5).trim();
        if (raw === '[DONE]') { onChunk('[DONE]'); return; }
        for (const inner of unwrap(raw)) onChunk(inner);
      };
      res.on('data', (c) => {
        buf += dec.write(c);
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          flushLine(line);
        }
      });
      res.on('end', () => {
        buf += dec.end();
        // 两个收尾细节，都实测自千问办公的流：
        //  1. 最后一帧常不带换行，只按 \n 切会把它留在 buf 里直到流关闭；
        //  2. 它**不发** `data: [DONE]`，而是用 `event:finish` + 统计帧收尾。
        //     所以这里必须补发一个 [DONE]，否则上层一直等结束标记，
        //     表现为流挂住不返回。
        flushLine(buf);
        onChunk('[DONE]');
        resolve({ status: res.statusCode, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('qwenwork upstream timeout')); });
    req.write(body);
    req.end();
  });
}

/** 非流式：聚合 SSE 成一个 chat.completion */
function aggregate(payloads, model) {
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage = {};
  let id = 'qwenwork';
  const created = Math.floor(Date.now() / 1000);
  // tool_calls 按 index 增量到达：第一帧带 id/name，后续帧只追加 arguments 片段。
  // 不合并就会丢掉工具调用（表现为 finish_reason=tool_calls 但 tool_calls 为 null，
  // 非流式客户端拿到一个空回答）。
  const calls = new Map();
  for (const p of payloads) {
    try {
      const o = JSON.parse(p);
      if (o.id) id = o.id;
      if (o.usage) usage = o.usage;
      const c = (o.choices || [{}])[0];
      if (c.finish_reason) finish = c.finish_reason;
      const d = c.delta || c.message || {};
      if (d.content) content += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = tc.index != null ? tc.index : 0;
          const cur = calls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function) {
            if (tc.function.name) cur.function.name = tc.function.name;
            if (tc.function.arguments) cur.function.arguments += tc.function.arguments;
          }
          calls.set(idx, cur);
        }
      }
    } catch (e) { /* 非 JSON 帧跳过 */ }
  }
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.size) {
    message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    // 有工具调用时 content 常为空串，OpenAI 规范允许 content 为 null
    if (!content) message.content = null;
  }
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage || {},
  };
}

async function refreshToken(doc) {
  const refresh = doc && doc.refreshToken;
  if (!refresh) throw new Error('auth-v2.dat 缺少 refreshToken');
  const res = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ refresh_token: refresh, target: 'c' });
    const req = https.request({
      hostname: new URL(constants.GATEWAY).hostname,
      path: constants.REFRESH_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': constants.USER_AGENT,
        'X-Request-Id': crypto.randomUUID(),
        'Login-Version': constants.LOGIN_VERSION,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => {
        try { resolve({ status: r.statusCode, data: JSON.parse(b) }); }
        catch (e) { resolve({ status: r.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('refresh timeout')));
    req.write(body);
    req.end();
  });
  const token = res.data && (res.data.device_token || res.data.token);
  if (!token) {
    // refresh token 失效是**必然会遇到**的情况：它有独立有效期（比 access
    // token 短），过期后只能重新登录客户端。报「未返回 device_token」会让人
    // 去查网络，其实该做的是打开千问办公重新登录。把上游的 errorCode 带上。
    const code = (res.data && (res.data.errorCode || res.data.error)) || `HTTP ${res.status}`;
    const detail = (res.data && res.data.errorMessage) || '';
    const err = new Error(
      `千问办公登录态已失效（${code}${detail ? ': ' + detail : ''}）。` +
      '请打开千问办公客户端重新登录一次，让 auth-v2.dat 刷新。'
    );
    err.statusCode = 401;
    throw err;
  }
  const next = {
    ...doc,
    token,
    refreshToken: (res.data && res.data.refresh_token) || refresh,
  };
  if (res.data && res.data.expires_at) next.expiresAt = res.data.expires_at;
  // 写回原文件：refresh token 是轮换的，客户端和我们在同一份文件上各刷一次
  // 会互踩（一边刷新会让另一边的 refresh token 失效）。
  try { credentials.encryptAuth(next); } catch (e) { /* 写回失败不阻断本次请求 */ }
  authCache = { at: Date.now(), doc: next };
  return next;
}

/** 取可用登录态，过期则刷新 */
async function ensureAuth() {
  let doc = loadAuth();
  if (credentials.isExpired(doc)) doc = await refreshToken(doc);
  return doc;
}

module.exports = {
  buildBody,
  resolveModelKey,
  unwrap,
  envelopeStatus,
  payloadError,
  post,
  postStream,
  aggregate,
  ensureAuth,
  refreshToken,
  loadAuth,
};
