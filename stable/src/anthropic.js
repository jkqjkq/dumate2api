// dumate2api - Anthropic Messages API -> OpenAI Chat Completions translation layer
const { resolveMaxTokens } = require('./budget');
const modelmap = require('./modelmap');

// 模型映射已抽到 modelmap.js（可经管理端编辑，落 data/model-map.json）。
// 这里保留 MODEL_MAP 导出以兼容既有引用，值是默认表。
const MODEL_MAP = modelmap.DEFAULT_ALIASES;

function mapModel(name) {
  return modelmap.mapModel(name);
}

// Convert Anthropic Messages request to OpenAI Chat Completions request
function anthropicToOpenAI(anthropicReq) {
  const messages = [];

  // System prompt
  if (anthropicReq.system) {
    const sysContent = typeof anthropicReq.system === 'string'
      ? anthropicReq.system
      : anthropicReq.system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
    if (sysContent) messages.push({ role: 'system', content: sysContent });
  }

  // Messages
  for (const msg of (anthropicReq.messages || [])) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Content blocks
        const parts = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            parts.push({ type: 'text', text: `[Tool Use: ${block.name}]\n${JSON.stringify(block.input)}` });
          } else if (block.type === 'tool_result') {
            const content = typeof block.content === 'string' ? block.content :
              (block.content || []).map(c => c.text || '').join('\n');
            parts.push({ type: 'text', text: `[Tool Result]\n${content}` });
          } else if (block.type === 'image') {
            parts.push({ type: 'text', text: '[Image content - not supported by DuMate backend]' });
          }
        }
        // OpenAI format: string content or array of {type, text}
        const textContent = parts.map(p => p.text).join('\n');
        messages.push({ role: msg.role, content: textContent });
      }
    }
  }

  // 预算统一由 budget.js 判定：客户端值只作参考，reasoning 与正文共用预算，
  // 客户端给的小值会让 reasoning 吃光正文导致空回答 / 半句截断。
  const maxTokens = resolveMaxTokens(anthropicReq.max_tokens);

  const openaiReq = {
    // **不要在这里 mapModel**：模型名必须先经 upstream-router 按前缀分流
    // （`qwen/` / `traework/`）。提前过搭子的别名表会把带前缀的名字兜底成
    // `model-text`，斜杠随之消失，下游 resolve() 就只能判成搭子通道——
    // 请求返回 200，但回答来自完全不同的模型，客户端无从察觉。
    // 映射统一在 server.js 的 needsModelMap 分支里做，与 responses.js 同口径。
    model: anthropicReq.model || 'model-text',
    messages: messages,
    max_tokens: maxTokens,
    temperature: anthropicReq.temperature,
    top_p: anthropicReq.top_p,
    stream: anthropicReq.stream || false,
  };

  if (anthropicReq.stop_sequences) {
    openaiReq.stop = anthropicReq.stop_sequences;
  }

  return openaiReq;
}

// Convert OpenAI Chat Completions response to Anthropic Messages response
function openAIToAnthropic(openaiResp, originalModel) {
  const choice = openaiResp.choices && openaiResp.choices[0];
  const message = choice ? choice.message : {};
  const content = [];

  // Reasoning content -> thinking block
  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }

  // Main content
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  const anthropicResp = {
    id: openaiResp.id || ('msg_' + Date.now()),
    type: 'message',
    role: 'assistant',
    model: originalModel || 'claude-3-5-sonnet-20241022',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stop_reason: mapFinishReason(choice ? choice.finish_reason : null),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage ? openaiResp.usage.prompt_tokens : 0,
      output_tokens: openaiResp.usage ? openaiResp.usage.completion_tokens : 0,
    },
  };

  return anthropicResp;
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

module.exports = { MODEL_MAP, mapModel, anthropicToOpenAI, openAIToAnthropic, mapFinishReason };
