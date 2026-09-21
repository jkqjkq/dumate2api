// dumate2api - Google Generative Language (v1beta) <-> OpenAI Chat translation
//
// Gemini CLI talks the native Google protocol through GoogleGenAI when
// GOOGLE_GEMINI_BASE_URL is set. DuMate upstream only speaks OpenAI chat
// completions, so this module converts between the two:
//   - generateContent / streamGenerateContent request  -> OpenAI chat request
//   - OpenAI chat response / SSE stream                -> Google response
// Model names pass straight through so DuMate's own IDs (glm-5, model-text,
// claude-3-5-sonnet-20241022, gpt-4o) reach the upstream unchanged; unknown
// / legacy Gemini names fall back to glm-5 (the strongest local model).

const { resolveMaxTokens } = require('./budget');

const DEFAULT_MODEL = 'glm-5';

// Gemini CLI may be configured with a generic name; map those to DuMate-local.
const GEMINI_TO_DUMATE = {
  'gemini-2.5-pro': DEFAULT_MODEL,
  'gemini-2.5-flash': DEFAULT_MODEL,
  'gemini-3-pro': DEFAULT_MODEL,
  'gemini-3-flash': DEFAULT_MODEL,
  'gemini-3-pro-preview': DEFAULT_MODEL,
  'gemini-pro': DEFAULT_MODEL,
  'gemini-flash': DEFAULT_MODEL,
};

function mapModel(name) {
  if (!name) return DEFAULT_MODEL;
  if (GEMINI_TO_DUMATE[name]) return GEMINI_TO_DUMATE[name];
  // DuMate native IDs pass through untouched.
  return name;
}

function partsToText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      if (p && p.inlineData && p.inlineData.data) {
        return '[Image content - not supported by DuMate backend]';
      }
      return '';
    })
    .join('\n');
}

// Google request -> OpenAI chat request
function googleToOpenAI(googleReq) {
  const messages = [];

  const sys = googleReq.systemInstruction;
  if (sys) {
    const sysText = Array.isArray(sys) ? partsToText(sys) : partsToText(sys.parts);
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  for (const content of (googleReq.contents || [])) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const parts = content.parts || [];

    const toolCalls = [];
    const toolResults = [];
    const texts = [];

    for (const p of parts) {
      if (typeof p === 'string') {
        texts.push(p);
      } else if (p && typeof p.text === 'string') {
        texts.push(p.text);
      } else if (p && p.functionCall) {
        toolCalls.push({
          id: p.functionCall.id || ('call_' + Math.random().toString(36).slice(2, 10)),
          type: 'function',
          function: {
            name: p.functionCall.name || '',
            arguments: JSON.stringify(p.functionCall.args || {}),
          },
        });
      } else if (p && p.functionResponse) {
        toolResults.push({
          tool_call_id: p.functionResponse.id || '',
          role: 'tool',
          content: typeof p.functionResponse.response === 'string'
            ? p.functionResponse.response
            : JSON.stringify(p.functionResponse.response || {}),
        });
      }
    }

    if (toolCalls.length) {
      messages.push({ role: 'assistant', content: texts.join('\n') || null, tool_calls: toolCalls });
    } else if (toolResults.length) {
      messages.push(...toolResults);
    } else {
      const text = texts.join('\n');
      if (text) messages.push({ role, content: text });
    }
  }

  const cfg = googleReq.generationConfig || {};
  // 预算统一由 budget.js 判定：reasoning 与正文共用 max_tokens，客户端小值
  // 会让正文被 reasoning 吃光。
  const openaiReq = {
    model: mapModel(googleReq.model),
    messages,
    max_tokens: resolveMaxTokens(cfg.maxOutputTokens || cfg.max_tokens),
    temperature: cfg.temperature,
    top_p: cfg.topP,
    stream: googleReq.stream || false,
  };
  if (Array.isArray(cfg.stopSequences) && cfg.stopSequences.length) {
    openaiReq.stop = cfg.stopSequences;
  }

  // functionDeclarations -> OpenAI tools
  const fns = (googleReq.tools || [])
    .flatMap((t) => (t.functionDeclarations || []))
    .filter((f) => f && f.name);
  if (fns.length) {
    openaiReq.tools = [{
      type: 'function',
      function: {
        name: '_tools',
        description: 'Available tool calls',
        parameters: {
          type: 'object',
          properties: Object.fromEntries(fns.map((f) => [f.name, {
            type: 'object',
            description: f.description || '',
            properties: (f.parameters && f.parameters.properties) || {},
          }])),
        },
      },
    }];
  }

  return openaiReq;
}

function finishReasonMap(reason) {
  switch (reason) {
    case 'length': return 'MAX_TOKENS';
    case 'content_filter': return 'SAFETY';
    default: return 'STOP';
  }
}

// OpenAI response -> Google generateContent response
function openAIToGoogle(openaiResp, originalModel) {
  const choice = openaiResp.choices && openaiResp.choices[0];
  const message = choice ? choice.message : {};
  const parts = [];

  if (message.reasoning_content) {
    parts.push({ text: message.reasoning_content, thought: true });
  }

  if (message.tool_calls && message.tool_calls.length) {
    for (const tc of message.tool_calls) {
      parts.push({
        functionCall: {
          id: tc.id,
          name: tc.function && tc.function.name,
          args: (() => {
            try { return JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch { return {}; }
          })(),
        },
      });
    }
  }

  if (message.content) {
    parts.push({ text: message.content });
  }
  if (!parts.length) parts.push({ text: '' });

  const usage = openaiResp.usage || {};
  return {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: finishReasonMap(choice ? choice.finish_reason : null),
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
    modelVersion: originalModel || openaiResp.model || DEFAULT_MODEL,
  };
}

// Translate OpenAI SSE stream into Google streamGenerateContent SSE events.
function translateStreamToGoogle(upstreamRes, res, originalModel) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = null;

  upstreamRes.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.substring(6).trim();
      if (dataStr === '[DONE]') continue;
      let chunkJson;
      try { chunkJson = JSON.parse(dataStr); } catch { continue; }

      if (chunkJson.usage) {
        if (chunkJson.usage.prompt_tokens != null) inputTokens = chunkJson.usage.prompt_tokens;
        if (chunkJson.usage.completion_tokens != null) outputTokens = chunkJson.usage.completion_tokens;
      }
      const delta = chunkJson.choices && chunkJson.choices[0] && chunkJson.choices[0].delta;
      if (!delta) continue;
      if (chunkJson.choices && chunkJson.choices[0].finish_reason) {
        finishReason = chunkJson.choices[0].finish_reason;
      }

      const parts = [];
      if (delta.reasoning_content) parts.push({ text: delta.reasoning_content, thought: true });
      if (delta.tool_calls && delta.tool_calls.length) {
        for (const tc of delta.tool_calls) {
          parts.push({
            functionCall: {
              id: tc.id,
              name: tc.function && tc.function.name,
              args: (() => {
                try { return JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch { return {}; }
              })(),
            },
          });
        }
      }
      if (delta.content) parts.push({ text: delta.content });

      if (parts.length) {
        send({
          candidates: [{
            content: { role: 'model', parts },
            finishReason: null,
            index: 0,
          }],
        });
      }
    }
  });

  upstreamRes.on('end', () => {
    send({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: finishReasonMap(finishReason), index: 0 }] });
    if (inputTokens || outputTokens) {
      send({
        usageMetadata: {
          promptTokenCount: inputTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: inputTokens + outputTokens,
        },
      });
    }
    // Google's streaming protocol ends by closing the connection; no [DONE]
    // sentinel (that is an OpenAI SSE convention and breaks GoogleGenAI).
    res.end();
  });

  upstreamRes.on('error', () => {
    res.end();
  });
}

module.exports = { DEFAULT_MODEL, mapModel, googleToOpenAI, openAIToGoogle, translateStreamToGoogle };