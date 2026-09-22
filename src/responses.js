// dumate2api - OpenAI Responses API (/v1/responses) -> Chat Completions 适配层
//
// Codex CLI 0.155+ 只认 `wire_api = "responses"`（`chat` 已被移除），
// 所以代理必须自己提供 /v1/responses，把它翻译成上游唯一的
// /chat/completions 调用。
//
// 覆盖范围：
//   - 请求：instructions / input(字符串或 item 数组) / tools(function|local_shell)
//           / tool_choice / max_output_tokens / temperature / top_p / stream
//   - 响应：非流式 responses 对象，流式则翻译成 Responses 的语义事件序列
//     (response.created / output_item.added / output_text.delta /
//      function_call_arguments.delta / response.completed ...)
//
// 明确不支持的字段（静默忽略并记一条日志）：
//   - previous_response_id / store（上游无状态，靠 Codex 自己回传完整 input）
//   - reasoning 配置、include、text.format(json_schema) 等

const { resolveMaxTokens } = require('./budget');
const { mapModel } = require('./anthropic');

// ---------- 请求侧 ----------

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (typeof p.text === 'string') return p.text;
      // input_text / output_text / 其它带 text 字段的块
      if (p.type === 'input_image' || p.type === 'image_url') {
        return '[Image content - not supported by DuMate backend]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// Responses 的 function 工具 -> Chat Completions 的 function 工具
function convertTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function') {
      const fn = t.function || t; // 两种形状都接受
      if (!fn.name) continue;
      out.push({
        type: 'function',
        function: {
          name: fn.name,
          description: fn.description || '',
          parameters: fn.parameters || { type: 'object', properties: {} },
        },
      });
    } else if (t.type === 'local_shell') {
      // Codex 的本地 shell 工具在上游没有对应实现，跳过（由 Codex 侧 fallback 处理）
      continue;
    }
  }
  return out.length ? out : null;
}

// Responses input -> Chat Completions messages
function inputToMessages(body) {
  const messages = [];

  const instructions = body.instructions;
  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({ role: 'system', content: instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    if (input.trim()) messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  // function_call 的 arguments 是分片到达的，按 call_id 聚合后再落到 tool_calls
  const pendingCalls = new Map();

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;

    switch (item.type) {
      case 'message':
      case undefined: {
        const role = item.role === 'assistant' ? 'assistant'
          : (item.role === 'system' || item.role === 'developer') ? 'system' : 'user';
        const text = textFromContent(item.content);
        if (!text) break;
        if (role === 'system') messages.push({ role: 'system', content: text });
        else messages.push({ role, content: text });
        break;
      }
      case 'function_call': {
        const id = item.call_id || item.id || ('call_' + Math.random().toString(36).slice(2, 10));
        pendingCalls.set(id, {
          id,
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' },
        });
        break;
      }
      case 'function_call_output': {
        const id = item.call_id || item.id || '';
        // 先把已聚合的 tool_calls 落到一条 assistant 消息里
        if (pendingCalls.size) {
          messages.push({ role: 'assistant', content: null, tool_calls: [...pendingCalls.values()] });
          pendingCalls.clear();
        }
        const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
        messages.push({ role: 'tool', tool_call_id: id, content: out });
        break;
      }
      // reasoning / local_shell_call 等：上游不认，直接丢弃
      default:
        break;
    }
  }

  if (pendingCalls.size) {
    messages.push({ role: 'assistant', content: null, tool_calls: [...pendingCalls.values()] });
  }

  return messages;
}

function responsesToOpenAI(body, stream) {
  const messages = inputToMessages(body);
  const tools = convertTools(body.tools);

  const req = {
    model: mapModel(body.model || 'model-text'),
    messages,
    max_tokens: resolveMaxTokens(body.max_output_tokens),
    stream: !!stream,
  };
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (tools) req.tools = tools;

  const choice = body.tool_choice;
  if (choice === 'auto' || choice === 'none' || choice === 'required') {
    req.tool_choice = choice;
  } else if (choice && typeof choice === 'object' && choice.name) {
    req.tool_choice = { type: 'function', function: { name: choice.name } };
  }

  return req;
}

// ---------- 响应侧 ----------

function newResponseId() {
  return 'resp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function usageFrom(openaiUsage) {
  const u = openaiUsage || {};
  return {
    input_tokens: u.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: u.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
    total_tokens: u.total_tokens || 0,
  };
}

// 非流式：OpenAI 响应 -> Responses 对象
function openAIToResponse(openaiResp, model) {
  const choice = (openaiResp.choices && openaiResp.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];

  // reasoning -> reasoning item（Codex 会把它当思考过程展示）
  if (msg.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: 'rs_' + Math.random().toString(36).slice(2, 10),
      summary: [{ type: 'summary_text', text: msg.reasoning_content }],
    });
  }

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: 'fc_' + Math.random().toString(36).slice(2, 10),
        call_id: tc.id || '',
        name: (tc.function && tc.function.name) || '',
        arguments: (tc.function && tc.function.arguments) || '{}',
        status: 'completed',
      });
    }
  }

  if (msg.content) {
    output.push({
      type: 'message',
      id: 'msg_' + Math.random().toString(36).slice(2, 10),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: msg.content, annotations: [], logprobs: [] }],
    });
  }

  return {
    id: openaiResp.id || newResponseId(),
    object: 'response',
    created_at: openaiResp.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: model || openaiResp.model || 'model-text',
    output,
    output_text: msg.content || '',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: usageFrom(openaiResp.usage),
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    temperature: null,
    top_p: null,
  };
}

// 流式：OpenAI SSE -> Responses SSE
function translateStreamToResponses(upstreamRes, res, model, onDone) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // 收尾时把最终 usage 交回调用方做埋点；两条收尾路径都要走一次
  let finished = false;
  const finish = (status) => {
    if (finished) return;
    finished = true;
    if (onDone) {
      const u = usage ? usageFrom(usage) : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      onDone(
        { input: u.input_tokens || 0, output: u.output_tokens || 0, total: u.total_tokens || 0 },
        status,
      );
    }
  };

  const responseId = newResponseId();
  const createdAt = Math.floor(Date.now() / 1000);
  const send = (type, payload) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const baseResponse = (status, output) => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model: model || 'model-text',
    output: output || [],
    output_text: '',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    temperature: null,
    top_p: null,
  });

  let buffer = '';
  let seq = 0;
  let textItemId = null;
  let textOutputIndex = -1;
  let fullText = '';
  let reasoningItemId = null;
  let reasoningOutputIndex = -1;
  let fullReasoning = '';
  const callItems = new Map(); // tool_call index -> { id, itemId, name, args, outputIndex }
  let usage = null;
  let finishReason = null;
  let nextOutputIndex = 0;

  send('response.created', { type: 'response.created', sequence_number: seq++, response: baseResponse('in_progress') });
  send('response.in_progress', { type: 'response.in_progress', sequence_number: seq++, response: baseResponse('in_progress') });

  const closeTextItem = () => {
    if (textItemId) {
      send('response.output_text.done', {
        type: 'response.output_text.done', sequence_number: seq++, item_id: textItemId,
        output_index: textOutputIndex, content_index: 0, text: fullText,
      });
      send('response.output_item.done', {
        type: 'response.output_item.done', sequence_number: seq++, output_index: textOutputIndex,
        item: { type: 'message', id: textItemId, status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: fullText, annotations: [], logprobs: [] }] },
      });
      textItemId = null;
    }
  };

  upstreamRes.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.substring(6).trim();
      if (dataStr === '[DONE]') continue;

      let cj;
      try { cj = JSON.parse(dataStr); } catch { continue; }

      if (cj.usage) usage = cj.usage;
      const choice = cj.choices && cj.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;

      // reasoning 增量
      if (delta.reasoning_content) {
        if (!reasoningItemId) {
          reasoningItemId = 'rs_' + Math.random().toString(36).slice(2, 10);
          reasoningOutputIndex = nextOutputIndex++;
          send('response.output_item.added', {
            type: 'response.output_item.added', sequence_number: seq++, output_index: reasoningOutputIndex,
            item: { type: 'reasoning', id: reasoningItemId, summary: [] },
          });
        }
        fullReasoning += delta.reasoning_content;
        send('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta', sequence_number: seq++,
          item_id: reasoningItemId, output_index: reasoningOutputIndex, summary_index: 0,
          delta: delta.reasoning_content,
        });
      }

      // 工具调用增量
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index != null ? tc.index : 0;
          let entry = callItems.get(idx);
          if (!entry) {
            entry = { id: tc.id || ('call_' + Math.random().toString(36).slice(2, 10)),
              itemId: 'fc_' + Math.random().toString(36).slice(2, 10),
              name: (tc.function && tc.function.name) || '', args: '', outputIndex: nextOutputIndex++ };
            callItems.set(idx, entry);
            send('response.output_item.added', {
              type: 'response.output_item.added', sequence_number: seq++, output_index: entry.outputIndex,
              item: { type: 'function_call', id: entry.itemId, call_id: entry.id,
                name: entry.name, arguments: '', status: 'in_progress' },
            });
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function && tc.function.name) entry.name = tc.function.name;
          const argDelta = (tc.function && tc.function.arguments) || '';
          if (argDelta) {
            entry.args += argDelta;
            send('response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta', sequence_number: seq++,
              item_id: entry.itemId, output_index: entry.outputIndex, delta: argDelta,
            });
          }
        }
      }

      // 正文增量
      if (delta.content) {
        if (!textItemId) {
          closeReasoningLater();
          textItemId = 'msg_' + Math.random().toString(36).slice(2, 10);
          textOutputIndex = nextOutputIndex++;
          send('response.output_item.added', {
            type: 'response.output_item.added', sequence_number: seq++, output_index: textOutputIndex,
            item: { type: 'message', id: textItemId, status: 'in_progress', role: 'assistant', content: [] },
          });
          send('response.content_part.added', {
            type: 'response.content_part.added', sequence_number: seq++, item_id: textItemId,
            output_index: textOutputIndex, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
          });
        }
        fullText += delta.content;
        send('response.output_text.delta', {
          type: 'response.output_text.delta', sequence_number: seq++, item_id: textItemId,
          output_index: textOutputIndex, content_index: 0, delta: delta.content, logprobs: [],
        });
      }
    }
  });

  let reasoningClosed = false;
  function closeReasoningLater() {
    if (reasoningItemId && !reasoningClosed) {
      reasoningClosed = true;
      send('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done', sequence_number: seq++, item_id: reasoningItemId,
        output_index: reasoningOutputIndex, summary_index: 0, text: fullReasoning,
      });
      send('response.output_item.done', {
        type: 'response.output_item.done', sequence_number: seq++, output_index: reasoningOutputIndex,
        item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: fullReasoning }] },
      });
    }
  }

  upstreamRes.on('end', () => {
    closeReasoningLater();
    closeTextItem();

    for (const entry of callItems.values()) {
      send('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done', sequence_number: seq++, item_id: entry.itemId,
        output_index: entry.outputIndex, arguments: entry.args,
      });
      send('response.output_item.done', {
        type: 'response.output_item.done', sequence_number: seq++, output_index: entry.outputIndex,
        item: { type: 'function_call', id: entry.itemId, call_id: entry.id, name: entry.name,
          arguments: entry.args, status: 'completed' },
      });
    }

    const incomplete = finishReason === 'length';
    send('response.completed', {
      type: 'response.completed',
      sequence_number: seq++,
      response: {
        ...baseResponse(incomplete ? 'incomplete' : 'completed'),
        output_text: fullText,
        usage: usageFrom(usage),
        incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
      },
    });
    res.end();
    finish(200);
  });

  upstreamRes.on('error', () => {
    send('response.failed', {
      type: 'response.failed', sequence_number: seq++,
      response: { ...baseResponse('failed'), error: { code: 'upstream_error', message: 'upstream stream error' } },
    });
    res.end();
    finish(502);
  });
}

module.exports = { responsesToOpenAI, openAIToResponse, translateStreamToResponses };
