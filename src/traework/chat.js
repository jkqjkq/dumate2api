// src/traework/chat.js - 对话（llm_utils_chat）与 SSE 解析
//
// 与 OpenAI 的差异（参考 traework2api 的 PrepareBody，逐条对齐）：
//   1. content 必须是**数组** [{type:'text',text:...}]，字符串上游不认
//   2. 必须带 function:"solo_work_lite"，否则上游拒
//   3. model 同时写进 config_name 与 model 两个字段
//   4. stream 强制 true（上游只走 SSE，非流式由我们聚合）
//   5. tools[].function.parameters 上游是 **string 类型**（OpenAI 标准是 object），
//      要把对象序列化成 JSON 字符串
//   6. tool_choice 上游只认字符串（"auto"/"required"/函数名），对象要归一化
//   7. assistant 回传的 tool_calls 要改成 function_call 形状
const https = require('https');
const c = require('./constants');
const { soloHeaders } = require('./headers');

/** 把 OpenAI 请求体改写成 SOLO 的形状 */
function buildBody(payload, model) {
  const obj = JSON.parse(JSON.stringify(payload || {}));
  obj.stream = true;
  obj.function = c.FUNCTION;

  const modelName = String(model || obj.model || c.DEFAULT_MODEL).trim() || c.DEFAULT_MODEL;
  obj.model = modelName;
  obj.config_name = modelName;

  // messages：content 字符串 → 数组；assistant 的 tool_calls → function_call
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        const kept = [];
        for (const tc of m.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          if (tc.function && !tc.function_call) {
            tc.function_call = tc.function;
            delete tc.function;
          }
          const name = tc.function_call && tc.function_call.name;
          // 上游要求 FunctionCall.Name 必填，无 name 的整条剔除
          if (!name || !String(name).trim()) continue;
          kept.push(tc);
        }
        if (kept.length) m.tool_calls = kept; else delete m.tool_calls;
      }
      if (m.content == null) continue;
      if (typeof m.content === 'string') {
        m.content = [{ type: 'text', text: m.content }];
      }
      // 已是数组则透传
    }
  }

  // tools：parameters 对象 → JSON 字符串；非 function 形状剔除
  if (Array.isArray(obj.tools)) {
    const out = [];
    for (const t of obj.tools) {
      if (!t || typeof t !== 'object') continue;
      if (t.type !== 'function' || !t.function || !t.function.name) continue;
      const fn = { ...t.function };
      if (fn.parameters && typeof fn.parameters === 'object') {
        fn.parameters = JSON.stringify(fn.parameters);
      }
      out.push({ type: 'function', function: fn });
    }
    if (out.length) obj.tools = out; else delete obj.tools;
  }

  // tool_choice：上游只认字符串
  const tc = obj.tool_choice;
  if (tc != null) {
    if (typeof tc === 'string') {
      if (tc.toLowerCase() === 'none') { delete obj.tool_choice; delete obj.tools; }
      // auto / required 原样保留
    } else if (typeof tc === 'object') {
      const typ = String(tc.type || '').toLowerCase();
      if (typ === 'none') { delete obj.tool_choice; delete obj.tools; }
      else if (typ === 'auto' || typ === 'required') obj.tool_choice = typ;
      else if (typ === 'function') {
        const n = (tc.function && tc.function.name) || tc.name || '';
        obj.tool_choice = String(n).trim() || 'auto';
      } else delete obj.tool_choice;
    } else delete obj.tool_choice;
  }

  return JSON.stringify(obj);
}

/** 发流式请求。返回 { stream, status, raw } */
function postStream(body, auth) {
  return new Promise((resolve) => {
    const u = new URL(c.AGENT_HOST + c.EP_CHAT);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { ...soloHeaders(auth, true), 'Content-Length': Buffer.byteLength(body) },
      // 长流不能设总超时，否则 SSE 会被掐断
      timeout: c.STREAM_TIMEOUT_MS,
    }, (res) => resolve({ stream: res, status: res.statusCode }));
    req.on('error', (e) => resolve({ stream: null, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ stream: null, status: 0, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

/**
 * 从事件里取上游报错。**TRAE 的错误是流里的一个事件，不是 HTTP 状态码**：
 * 模型名不认识时返回 `event:error` + `{"code":4001,"message":"...param is invalid"}`，
 * 而 HTTP 仍是 200。
 *
 * 不判这个会把失败当成「成功的空回答」——客户端拿到 200 + 空正文，
 * 无从察觉；这正是最难排查的那类静默失败。
 *
 * @returns {{code:number, message:string}|null}
 */
function eventError(evt) {
  if (!evt || evt.event !== 'error') return null;
  const d = evt.data || {};
  return {
    code: Number(d.code) || 0,
    message: String(d.message || d.error || '上游返回错误'),
  };
}

/**
 * 解析 TRAE 的 SSE 流。
 *
 * **它不是 OpenAI 格式**，是 `event:xxx\ndata:{...}` 的自定义事件流：
 *   metadata     会话信息（忽略）
 *   timing_cost  性能数据（忽略）
 *   output       正文流 —— {response, reasoning_content, tool_calls, phase}
 *   extra_info   汇总帧（含完整 reasoning，忽略：正文已逐块收到）
 *   token_usage  用量 —— {prompt_tokens, completion_tokens, reasoning_tokens}
 *   done         结束 —— {finish_reason}
 *   error        上游报错 —— {code, message}（HTTP 仍是 200，必须自己判）
 *
 * 注意结束标记是 `event:done`，**不是** `data: [DONE]`。
 * 所以这里不按 OpenAI 的 `data:` 单行协议解析，而是按「事件块」切分。
 *
 * onEvent 回调收到 { event, data }（data 已 JSON 解析）。
 */
async function readStream(stream, onEvent) {
  const { StringDecoder } = require('string_decoder');
  const dec = new StringDecoder('utf8');
  let buf = '';
  return new Promise((resolve, reject) => {
    const flushBlock = (block) => {
      const lines = block.split('\n');
      let event = '';
      const dataLines = [];
      for (const l of lines) {
        if (l.startsWith('event:')) event = l.slice(6).trim();
        else if (l.startsWith('data:')) dataLines.push(l.slice(5).trim());
      }
      if (!event && !dataLines.length) return;
      const raw = dataLines.join('\n');
      let data = null;
      if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { _raw: raw }; } }
      onEvent({ event, data });
    };

    stream.on('data', (chunk) => {
      buf += dec.write(chunk);
      // 事件之间以空行分隔
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.trim()) flushBlock(block);
      }
    });
    stream.on('end', () => {
      buf += dec.end();
      if (buf.trim()) flushBlock(buf);
      resolve();
    });
    stream.on('error', reject);
  });
}

/** 把 TRAE 的 output 事件转成 OpenAI chunk 形状（便于上层统一处理） */
function toOpenAIChunk(evt, model) {
  const d = evt.data || {};
  const delta = {};
  if (d.response) delta.content = d.response;
  if (d.reasoning_content) delta.reasoning_content = d.reasoning_content;
  if (Array.isArray(d.tool_calls) && d.tool_calls.length) delta.tool_calls = d.tool_calls;
  return {
    id: 'traework',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

/**
 * 聚合整轮结果（非流式路径）。
 * 输入是 readStream 收集到的 [{event, data}]。
 */
function aggregate(events, model) {
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage = null;
  let sessionId = '';
  let err = null;
  const calls = new Map();

  for (const e of events) {
    const d = e.data || {};
    if (e.event === 'metadata' && d.session_id) sessionId = d.session_id;
    if (e.event === 'error') err = eventError(e);
    if (e.event === 'output') {
      if (d.response) content += d.response;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          if (!tc) continue;
          const i = tc.index != null ? tc.index : calls.size;
          const cur = calls.get(i) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) cur.id = tc.id;
          const fn = tc.function || tc;
          if (fn && fn.name) cur.function.name = fn.name;
          if (fn && fn.arguments) {
            cur.function.arguments += (typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments));
          }
          calls.set(i, cur);
        }
      }
    }
    if (e.event === 'token_usage') {
      usage = {
        prompt_tokens: d.prompt_tokens || 0,
        completion_tokens: d.completion_tokens || 0,
        total_tokens: d.total_tokens || 0,
        completion_tokens_details: { reasoning_tokens: d.reasoning_tokens || 0 },
      };
    }
    if (e.event === 'done' && d.finish_reason) finish = d.finish_reason;
  }

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.size) {
    message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (!content) message.content = null;
  }
  const out = {
    id: sessionId || 'traework',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage || {},
  };
  // 上游报错时抛出去，而不是返回一个空的 200。上层（server.js）会据此回
  // 正经的 4xx，客户端才知道这次没跑成。
  if (err) {
    const e = new Error(`traework ${err.code}: ${err.message}`);
    e.statusCode = err.code >= 400 && err.code < 600 ? err.code : 400;
    e.upstreamCode = err.code;
    throw e;
  }
  return out;
}

module.exports = { buildBody, postStream, readStream, toOpenAIChunk, aggregate, eventError };
