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

function resolveModelKey(name) {
  const raw = String(name || '').trim() || c.DEFAULT_MODEL;
  return c.MODEL_ALIASES[raw] || raw;
}

/** 构造上游请求体（OpenAI 形状 → Qoder 形状） */
function buildBody(modelKey, payload) {
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
      max_input_tokens: 200000,
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

/** 从内层 payload 判定是否错误 */
function payloadError(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const code = obj.code != null ? Number(obj.code) : null;
  if (code && code >= 400) {
    return { code, message: String(obj.message || obj.error || '') };
  }
  if (typeof obj.code === 'string' && /^[A-Z]/.test(obj.code) && obj.message) {
    return { code: 500, message: `${obj.code}: ${obj.message}` };
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
      headers: { ...headers, Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => { buf += dec.end(); resolve({ status: res.statusCode, headers: res.headers, raw: buf }); });
      res.on('error', reject);
    });
    req.on('error', reject);
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
        buf += dec.write(chunk);
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          flushLine(line);
        }
      });
      res.on('end', () => {
        buf += dec.end();
        // 收尾：最后一帧常不带换行；且上游不发 [DONE]，要自己补
        flushLine(buf);
        onChunk('[DONE]');
        resolve({ status: res.statusCode, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
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
