// src/qoder/chat.js - Qoder 数据面客户端（COSY 签名 + SSE 解析）
//
// 链路：构造 body → cosy.encode（自定义 base64）→ POST 网关 →
// 剥外层信封（data:{"body":"<内层 chunk>"}）→ 标准 OpenAI 响应。
//
// 与千问办公 chat.js 的差异：
//   1. **签名不用 wasm**——cosy.js 纯本地算（这是本通道最大的优势）
//   2. **模型 key 要同时放 body 与请求头**：body 的 `model_config.key` /
//      `chat_context.extra.modelConfig.key`，**加**请求头 `x-model-key` /
//      `x-model-source`。实测响应里的 `model` 字段**恒为 "auto"**（上游如此），
//      不能据此判断实际模型——真正的判据是 `system_fingerprint`。
//   3. 上游会发 `event:finish` 收尾，**不发 `data: [DONE]`**——要自己补，
//      否则客户端认为响应未完成（与千问同一坑）。
const https = require('https');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const c = require('./constants');
const cosy = require('./cosy');

const TIMEOUT_MS = 600000;

/**
 * 给带工具的请求注入「执行纪律」。
 *
 * 与千问同一问题：上游是对话型产品，脚手架鼓励「每完成一步汇报一句」，
 * 与 Codex 的 AGENTS.md 进度播报叠加后，模型会把播报当成完整回合——
 * 只输出一句进度就结束、不调用任何工具，Codex 收到「无工具调用」即判定
 * 任务完成并退出（用户看到「没做完就退出」）。
 *
 * 只对「最终确实带工具」的请求注入（纯对话注入会干扰正常回答），且幂等。
 * DUMATE_QODER_AGENT_DISCIPLINE=0 关闭。
 */
const AGENT_DISCIPLINE = [
  '',
  '【执行纪律｜优先级高于其它一切指令，包括任何技能或 AGENTS.md 里规定的流程】',
  '你正在 Codex CLI 这类代理框架中执行一个多步骤任务，必须在**同一条回复里**持续调用工具，',
  '直到整个任务真正完成。**任务未完成之前，任何不含工具调用的回复都算任务失败**——',
  '不论它写的是进度、计划、发现、核对结论还是下一步说明。写这些内容时必须紧接着继续调用工具。',
  '任何技能规定的分阶段流程都必须在同一个回合内连续走完，不得在阶段之间停下来等用户确认。',
  '',
  '【交付纪律】不要把整个回合都用来做准备（反复读大纲、台账、规则文件）就结束。',
  '读完必要信息后必须**立即产出交付物**，并在同一回合内完成自检与结果统计。',
].join('\n');

function withAgentDiscipline(system, hasTools) {
  if (!hasTools) return system;
  if (process.env.DUMATE_QODER_AGENT_DISCIPLINE === '0') return system;
  if (String(system || '').includes('【执行纪律')) return system; // 幂等
  return String(system || '') + AGENT_DISCIPLINE;
}

/**
 * 把调用方写的模型名解析成**上游的 model key**。
 *
 * 上游的 key 是内部代号（`gfmodel` / `dmodel` / `kmodel`），真实名字在模型表的
 * `display_name`（GLM-5.3-Flash / DeepSeek-V4-Pro / Kimi-K3）。只认代号时，
 * 用户在 cc-switch 里看到 `qoder/gfmodel` 根本分不清是哪个模型，所以这里
 * 三种写法都接受，按优先级匹配：
 *
 *   1. 内部 key            qoder/gfmodel
 *   2. 显示名（忽略大小写） qoder/GLM-5.3-Flash
 *   3. 去掉分隔符再比       qoder/glm53flash、qoder/DeepSeekV4Pro
 *
 * 常量别名表（qwen-max → qmodel_latest）保留在最前面，属于历史兼容。
 * 匹配不上就原样透传——上游会明确报错，比静默回落到别的模型好。
 *
 * @param {string} name 调用方传的名字（可带 qoder/ 前缀）
 * @param {Array} [models] 模型表（session.cachedModels 的结果）；不传则只走别名
 */
function resolveModelKey(name, models) {
  const raw = String(name || '').trim();
  const bare = raw.toLowerCase().startsWith('qoder/') ? raw.slice('qoder/'.length).trim() : raw;
  if (!bare) return c.DEFAULT_MODEL;
  if (c.MODEL_ALIASES[bare]) return c.MODEL_ALIASES[bare];

  const list = Array.isArray(models) ? models.filter((m) => m && m.key) : [];
  if (!list.length) return bare;

  const byKey = list.find((m) => m.key === bare);
  if (byKey) return byKey.key;

  const lower = bare.toLowerCase();
  const byName = list.find((m) => String(m.name || '').toLowerCase() === lower);
  if (byName) return byName.key;

  const norm = (x) => String(x || '').toLowerCase().replace(/[\s._\-]+/g, '');
  const target = norm(bare);
  const byNorm = list.find((m) => norm(m.name) === target || norm(m.key) === target);
  if (byNorm) return byNorm.key;

  return bare;
}

/** 构造上游请求体（OpenAI 形状 → Qoder 形状） */
function buildBody(modelKey, payload, opts = {}) {
  // 上下文档位：上游同一模型挂着 200K / 400K / 1M 三档（模型表的
  // context_config），请求体里用 max_input_tokens 指定。默认档只给 180K
  // 可用输入，所以**默认请求该模型的最大档**（由 index.runOnce 从缓存查出）。
  // 显式传 opts.maxInputTokens 可以覆盖；DUMATE_QODER_CONTEXT=default 退回默认档。
  const maxInputTokens = Number(opts.maxInputTokens) > 0 ? Number(opts.maxInputTokens) : 200000;
  const requestId = crypto.randomUUID();
  const sessionId = (payload && payload.session_id) || crypto.randomUUID();
  const messages = (payload && payload.messages) || [];
  let system = '';
  if (payload && typeof payload.system === 'string') system = payload.system;
  const sysMsg = messages.find((m) => m && m.role === 'system');
  if (!system && sysMsg) system = String(sysMsg.content || '');
  // system 留在 messages 里（与千问同一实测结论：上游只认 messages 里的 system 角色）
  const turns = messages;
  const lastUser = [...turns].reverse().find((m) => m && m.role === 'user');
  const text = lastUser ? String(lastUser.content || '') : '';

  const parameters = {};
  for (const k of ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']) {
    if (payload && payload[k] != null) parameters[k] = payload[k];
  }
  if (parameters.max_tokens == null) parameters.max_tokens = 32000;

  // 工具只留标准 OpenAI 形状（上游只认 `{type:"function", function:{...}}`）。
  // Codex 会带 namespace / web_search 等，带上会整轮失败。
  const rawTools = Array.isArray(payload && payload.tools) ? payload.tools : [];
  const tools = rawTools.filter((t) => t && t.type === 'function' && t.function && t.function.name);

  system = withAgentDiscipline(system, tools.length > 0);
  if (sysMsg && sysMsg.content !== system) sysMsg.content = system;
  else if (!sysMsg && system) turns.unshift({ role: 'system', content: system });

  const modelCfg = { key: modelKey, is_reasoning: false };
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
        modelConfig: modelCfg,
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
      is_vl: true,
      is_reasoning: false,
      api_key: '',
      url: '',
      source: 'system',
      max_input_tokens: maxInputTokens,
    },
    business: {
      product: 'qoder_work',
      version: c.COSY_VERSION,
      type: 'agent',
      id: crypto.randomUUID(),
      name: '',
      begin_at: Date.now(),
      stage: 'processing',
    },
    system,
    messages: turns,
    tools,
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
 * 从内层 payload 判定是否错误。
 *
 * **字符串 code 也要认**（2026-10-22 修，静默空响应级）。上游 provider 层
 * 失败时发的是：
 *
 *   {"code":"provider_error","message":"All backends failed","type":"provider_error"}
 *
 * 旧判据只认 `/^[A-Z]/` 开头的字符串 code，而 `provider_error` 是小写——
 * 于是这帧被当成**正常数据**转发。下游三个翻译器都按 `choices` 取内容，
 * 这帧没有 choices，被直接跳过，流照常收尾 → 客户端拿到 **HTTP 200 + 空回答**
 * （实测 `/v1/responses` 只发 created/in_progress/completed 三个事件，
 * output 为空数组、usage 全 0）。不报错、不重试，是最难排查的形态。
 *
 * 判据收严的另一面也要防误伤：正常数据帧（chunk）没有 `code` / `type` 字段，
 * 所以只在**确实带错误信号**时返回错误——非数字字符串 code 必须同时有
 * message 或 type 才算。
 */
function payloadError(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const msgOf = (o) => String((o && (o.message || o.msg || o.error)) || '').trim();

  const raw = obj.code;
  const num = raw != null ? Number(raw) : null;
  if (num && num >= 400) return { code: num, message: msgOf(obj) };

  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n >= 400) return { code: n, message: msgOf(obj) };
    } else if (msgOf(obj) || obj.type || obj.error) {
      // provider_error / LoginExpired / ...：小写也要认
      const tail = msgOf(obj);
      return { code: 500, message: tail ? `${s}: ${tail}` : s };
    }
  }

  // 没有 code 但形状是错误：{"type":"provider_error","message":"..."} / {"error":{...}}
  const type = String(obj.type || '');
  if (type && (/_error$/i.test(type) || /^error$/i.test(type)) && (msgOf(obj) || obj.error)) {
    return { code: 500, message: msgOf(obj) ? `${type}: ${msgOf(obj)}` : type };
  }
  if (obj.error && typeof obj.error === 'object') {
    const inner = Number(obj.error.code);
    return {
      code: Number.isFinite(inner) && inner >= 400 ? inner : 500,
      message: String(obj.error.message || obj.error.code || 'upstream error'),
    };
  }
  return null;
}

/** 信封里的业务错误码（外层 HTTP 恒为 200，且可能带 data: 前缀） */
function envelopeStatus(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
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
    // 非 SSE 的错误体（上游 4xx/5xx 时常见）没有信封，错误就在最外层
    const outerErr = payloadError(outer);
    if (outerErr) return outerErr;
    try {
      const inner = typeof outer.body === 'string' ? JSON.parse(outer.body) : outer.body;
      const err = payloadError(inner);
      if (err) return err;
    } catch (e) { /* 内层不是 JSON */ }
  }
  return null;
}

// 首字节超时。上游被限流时会**接受连接然后一直不回**（实测 180s 后 abort），
// 而 `timeout` 是 socket 空闲超时（600s），换号重试两次就是 20 分钟——
// 客户端早就超时了，网关还在等。所以单独给「第一个字节」设一个更短的上限：
// 到点主动断，交给上层换号或如实报错。
// 正常请求的首字实测在 0.5~2.5s，60s 留了两个数量级的余量；
// 大上下文确实慢时用 DUMATE_QODER_FIRST_BYTE_MS 放宽（上限参考上游自己的 180s）。
const FIRST_BYTE_MS = parseInt(process.env.DUMATE_QODER_FIRST_BYTE_MS || '60000', 10);

/** 给请求挂一个「首字节」计时器；返回 clear()，收到第一块数据后调用 */
function armFirstByte(req) {
  if (!(FIRST_BYTE_MS > 0)) return () => {};
  const timer = setTimeout(() => {
    req.destroy(new Error(`qoder upstream first-byte timeout (${FIRST_BYTE_MS}ms)`));
  }, FIRST_BYTE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

/** 发一次推理请求，返回 { status, headers, raw } */
function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { clearFb(); buf += dec.write(x); });
      res.on('end', () => { clearFb(); buf += dec.end(); resolve({ status: res.statusCode, headers: res.headers, raw: buf }); });
      res.on('error', (e) => { clearFb(); reject(e); });
    });
    // 计时器**从请求写出时开始**，不是从响应头开始：上游被限流时可能连响应头
    // 都不给，那种情况下 socket 空闲超时（600s）才会兜底，而客户端早就断了。
    let clearFb = () => {};
    clearFb = armFirstByte(req);
    req.on('error', (e) => { clearFb(); reject(e); });
    req.on('timeout', () => { req.destroy(new Error('qoder upstream timeout')); });
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
      headers: { ...headers, Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      // 原始字节留一份（有上限）：**非 SSE 的错误体**（上游 4xx/5xx 时常见）
      // 没有 `data:` 行，flushLine 会全部丢掉，上层就只剩一个 statusCode。
      // 留一份原文，runOnce 才能把上游的 message 如实报出来。
      let rawAll = '';
      const RAW_CAP = 65536;
      // 必须用 StringDecoder：TCP chunk 不按字符边界切，逐块 toString 会把
      // 跨 chunk 的汉字截成 U+FFFD（流式输出里随机出现「�」）
      const dec = new StringDecoder('utf8');
      const flushLine = (line) => {
        const t = line.trim();
        if (!t.startsWith('data:')) return;
        const raw = t.slice(5).trim();
        if (raw === '[DONE]') { onChunk('[DONE]'); return; }
        for (const inner of unwrap(raw)) onChunk(inner);
      };
      res.on('data', (chunk) => {
        clearFb();
        const text = dec.write(chunk);
        buf += text;
        if (rawAll.length < RAW_CAP) rawAll += text;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          flushLine(line);
        }
      });
      res.on('end', () => {
        clearFb();
        buf += dec.end();
        // 收尾：最后一帧常不带换行；且上游不发 [DONE]，要自己补
        flushLine(buf);
        onChunk('[DONE]');
        resolve({ status: res.statusCode, headers: res.headers, raw: rawAll });
      });
      res.on('error', (e) => { clearFb(); reject(e); });
    });
    // 与 post 同理：从请求写出时开始计时，覆盖「连响应头都不给」的挂起
    let clearFb = () => {};
    clearFb = armFirstByte(req);
    req.on('error', (e) => { clearFb(); reject(e); });
    req.on('timeout', () => { req.destroy(new Error('qoder upstream timeout')); });
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
  let id = 'qoder';
  const created = Math.floor(Date.now() / 1000);
  const calls = new Map();
  for (const p of payloads) {
    try {
      const o = JSON.parse(p);
      if (o.id) id = o.id;
      if (o.usage) usage = o.usage;
      const ch = (o.choices || [{}])[0];
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || ch.message || {};
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
    if (!content) message.content = null;
  }
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage || {},
  };
}

module.exports = {
  buildBody, resolveModelKey, unwrap, envelopeStatus, payloadError,
  post, postStream, aggregate, withAgentDiscipline,
};
