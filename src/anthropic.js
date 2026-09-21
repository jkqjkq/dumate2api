// dumate2api - Anthropic Messages API -> OpenAI Chat Completions translation layer
const { resolveMaxTokens } = require('./budget');

// Model name mapping: Anthropic/Claude model names -> DuMate model IDs
const MODEL_MAP = {
  // Claude models -> DuMate
  'claude-3-5-sonnet-20241022': 'model-text',
  'claude-3-5-sonnet-latest': 'model-text',
  'claude-3-5-haiku-20241022': 'model-text',
  'claude-3-5-haiku-latest': 'model-text',
  'claude-sonnet-4-20250514': 'model-text',
  'claude-opus-4-20250514': 'model-text',
  'claude-3-opus-20240229': 'model-text',
  'claude-3-haiku-20240307': 'model-text',
  // Direct DuMate model IDs pass through
  'model-text': 'model-text',
  'model-artifact-validate': 'model-artifact-validate',
  // OpenAI models (for Codex compatibility)
  'gpt-4o': 'model-text',
  'gpt-4o-mini': 'model-text',
  'gpt-4': 'model-text',
  'gpt-4-turbo': 'model-text',
  'o1': 'model-text',
  'o1-mini': 'model-text',
  'o3': 'model-text',
  'o3-mini': 'model-text',
  'gpt-5': 'model-text',
};

function mapModel(name) {
  if (!name) return 'model-text';
  return MODEL_MAP[name] || 'model-text';
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
    model: mapModel(anthropicReq.model),
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
