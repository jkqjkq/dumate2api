// dumate2api - Main server: OpenAI pass-through + Anthropic translation
const http = require('http');
const { discoverPort, verifyPort } = require('./discovery');
const { mapModel, anthropicToOpenAI, openAIToAnthropic, mapFinishReason } = require('./anthropic');
const { googleToOpenAI, openAIToGoogle, translateStreamToGoogle } = require('./google');
const { responsesToOpenAI, openAIToResponse, translateStreamToResponses } = require('./responses');
const { resolveMaxTokens } = require('./budget');

const PROXY_PORT = parseInt(process.env.DUMATE2API_PORT || '9080', 10);
const PROXY_HOST = process.env.DUMATE2API_HOST || '127.0.0.1';
const API_KEY = process.env.DUMATE2API_KEY || 'nokey';

let upstreamPort = null;
let upstreamManaged = false;
let lastDiscoveryTime = 0;
const DISCOVERY_INTERVAL = 30000; // re-discover every 30s if port changes

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function ensureUpstream() {
  const now = Date.now();
  if (upstreamPort && now - lastDiscoveryTime < DISCOVERY_INTERVAL) {
    return upstreamPort;
  }
  const port = await discoverPort();
  if (port) {
    if (port !== upstreamPort) {
      log(`Discovered DuMate main-server on port ${port}`);
    }
    upstreamPort = port;
    lastDiscoveryTime = now;
    return port;
  }
  // If we have a cached port, keep using it
  if (upstreamPort) return upstreamPort;
  throw new Error('DuMate main-server not found. Is DuMate running?');
}

// Forward request to DuMate upstream
//
// callback 只允许被调用一次：上游 socket 出错（含客户端主动 destroy）时
// Node 会同时触发 error 与后续事件，重复调用会让响应被写两次、
// 客户端永久挂在半开的流上（表现为「输出突然停止」）。
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.DUMATE_UPSTREAM_TIMEOUT_MS || '600000', 10);

function forwardToUpstream(port, path, method, headers, body, callback) {
  let settled = false;
  const once = (arg) => { if (!settled) { settled = true; callback(arg); } };

  const options = {
    host: '127.0.0.1',
    port: port,
    path: `/api/qianfanproxy/v1${path}`,
    method: method,
    timeout: UPSTREAM_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer nokey',
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
    }
  };

  const req = http.request(options, (upstreamRes) => {
    // 上游响应中途断开时，把中断交给下游 handler 收尾（各 handler 都监听了
    // 'error' 或 'end'）。这里不能吞掉，否则客户端会挂在半开的流上。
    upstreamRes.on('error', () => {});
    once(upstreamRes);
  });

  req.on('error', (err) => {
    once({
      fakeResponse: true,
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      write: () => {},
      end: () => {}
    });
  });
  req.on('timeout', () => {
    req.destroy(new Error('upstream timeout after ' + UPSTREAM_TIMEOUT_MS + 'ms'));
  });
  if (body) req.write(body);
  req.end();
  return req;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// 收全上游响应体后回调一次。end / aborted / error 三路都以同一入口收尾，
// 避免上游中途断开时下游永远等不到回调（「输出停止」类故障的根因之一）。
function collectAndFinish(upstreamRes, onComplete) {
  let data = '';
  let done = false;
  const finish = () => { if (!done) { done = true; onComplete(data); } };
  upstreamRes.on('data', (c) => data += c);
  upstreamRes.on('end', finish);
  upstreamRes.on('aborted', finish);
  upstreamRes.on('error', finish);
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// ==================== OpenAI Compatible Endpoints ====================

async function handleOpenAIModels(req, res) {
  // Return model list in OpenAI format
  sendJSON(res, 200, {
    object: 'list',
    data: [
      { id: 'model-text', object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'dumate' },
      { id: 'model-artifact-validate', object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'dumate' },
      { id: 'glm-5', object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'dumate' },
      { id: 'claude-3-5-sonnet-20241022', object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'dumate-proxy' },
      { id: 'gpt-4o', object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'dumate-proxy' },
    ]
  });
}

async function handleOpenAIChat(req, res) {
  const bodyStr = await readBody(req);
  let reqBody;
  try {
    reqBody = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }

  // Map model name
  reqBody.model = mapModel(reqBody.model);

  // 预算统一由 budget.js 判定：glm 的 reasoning 与正文共用一个 max_tokens
  // 预算，小预算会让正文被 reasoning 吃光（实测 max_tokens<=1024 时正文为空，
  // finish_reason=length）。
  reqBody.max_tokens = resolveMaxTokens(reqBody.max_tokens);

  const port = await ensureUpstream();
  const outBody = JSON.stringify(reqBody);

  const upstreamReq = forwardToUpstream(port, '/chat/completions', 'POST', {}, outBody, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      return sendJSON(res, 502, { error: { message: 'DuMate upstream unavailable', type: 'api_error' } });
    }

    if (reqBody.stream) {
      // Pass-through streaming
      res.writeHead(upstreamRes.statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      // 上游中途断开时必须主动收尾，否则客户端挂在半开的流上
      // （表现为「输出写到一半就停住，一直不返回」）。
      upstreamRes.on('aborted', () => res.end());
      upstreamRes.on('error', () => res.end());
      upstreamRes.pipe(res);
    } else {
      // Pass-through non-streaming
      let data = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        res.writeHead(upstreamRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      };
      upstreamRes.on('data', (c) => data += c);
      upstreamRes.on('end', finish);
      upstreamRes.on('aborted', finish);
      upstreamRes.on('error', finish);
    }
  });
}

// Rough token estimate. DuMate exposes no tokenizer, so bytes/4 is a
// deliberately conservative stand-in that keeps Claude Code happy.
function estimateTokens(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / 4);
  if (Array.isArray(value)) {
    return value.reduce((acc, b) => {
      if (typeof b === 'string') return acc + Math.ceil(b.length / 4);
      if (b && typeof b === 'object') {
        const t = typeof b.text === 'string' ? b.text : JSON.stringify(b.input || b.content || '');
        return acc + Math.ceil(t.length / 4);
      }
      return acc;
    }, 0);
  }
  return Math.ceil(String(value).length / 4);
}

async function handleAnthropicCountTokens(req, res) {
  const bodyStr = await readBody(req);
  let body;
  try {
    body = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
  }
  let total = estimateTokens(body.system);
  for (const m of (body.messages || [])) total += estimateTokens(m.content) + 4;
  for (const t of (body.tools || [])) total += estimateTokens(t.description || '') + estimateTokens(JSON.stringify(t.input_schema || {}));
  return sendJSON(res, 200, { type: 'count_tokens_result', input_tokens: total });
}

// ==================== Google Generative Language (v1beta) Compatible Endpoints ====================

async function handleGoogleModels(req, res) {
  sendJSON(res, 200, {
    models: [
      { name: 'models/glm-5', displayName: 'GLM-5', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
      { name: 'models/model-text', displayName: 'DuMate text', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
      { name: 'models/claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet (proxy)', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
      { name: 'models/gpt-4o', displayName: 'GPT-4o (proxy)', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
    ],
  });
}

async function handleGoogleGenerateContent(req, res, isStream) {
  const bodyStr = await readBody(req);
  let googleReq;
  try {
    googleReq = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { code: 400, message: 'Invalid JSON body', status: 'INVALID_ARGUMENT' } });
  }

  googleReq.stream = isStream;
  const openaiReq = googleToOpenAI(googleReq);

  const port = await ensureUpstream();
  const outBody = JSON.stringify(openaiReq);
  forwardToUpstream(port, '/chat/completions', 'POST', {}, outBody, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      return sendJSON(res, 502, { error: { code: 502, message: 'DuMate upstream unavailable', status: 'UNAVAILABLE' } });
    }

    if (isStream) {
      // Google streaming supports both ?alt=sse and bare streamGenerateContent.
      translateStreamToGoogle(upstreamRes, res, googleReq.model);
    } else {
      let data = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          const openaiResp = JSON.parse(data);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify(openAIToGoogle(openaiResp, googleReq.model)));
        } catch (e) {
          sendJSON(res, 502, { error: { code: 502, message: 'Upstream parse error: ' + data.substring(0, 200), status: 'INTERNAL' } });
        }
      };
      upstreamRes.on('data', (c) => data += c);
      upstreamRes.on('end', finish);
      upstreamRes.on('aborted', finish);
      upstreamRes.on('error', finish);
    }
  });
}

// ==================== OpenAI Responses API (Codex CLI) ====================

async function handleOpenAIResponses(req, res) {
  const bodyStr = await readBody(req);
  let reqBody;
  try {
    reqBody = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }

  const isStream = reqBody.stream !== false; // Codex 默认流式
  const openaiReq = responsesToOpenAI(reqBody, isStream);

  const port = await ensureUpstream();
  const outBody = JSON.stringify(openaiReq);
  forwardToUpstream(port, '/chat/completions', 'POST', {}, outBody, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      return sendJSON(res, 502, { error: { message: 'DuMate upstream unavailable', type: 'api_error' } });
    }
    if (!upstreamRes.statusCode || upstreamRes.statusCode >= 400) {
      return collectAndFinish(upstreamRes, (data) => {
        sendJSON(res, upstreamRes.statusCode || 502, {
          error: { message: 'Upstream error: ' + data.substring(0, 300), type: 'api_error' },
        });
      });
    }

    if (isStream) {
      translateStreamToResponses(upstreamRes, res, reqBody.model);
    } else {
      collectAndFinish(upstreamRes, (data) => {
        try {
          const openaiResp = JSON.parse(data);
          sendJSON(res, 200, openAIToResponse(openaiResp, reqBody.model));
        } catch (e) {
          sendJSON(res, 502, { error: { message: 'Upstream parse error: ' + data.substring(0, 200), type: 'api_error' } });
        }
      });
    }
  });
}

// ==================== Anthropic Compatible Endpoints ====================

async function handleAnthropicMessages(req, res) {
  const bodyStr = await readBody(req);
  let anthropicReq;
  try {
    anthropicReq = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
  }

  // Convert to OpenAI format
  const openaiReq = anthropicToOpenAI(anthropicReq);
  // Ask the upstream for a usage-bearing final chunk so we can report real
  // token counts instead of zeroes. Harmless if the upstream ignores it.
  if (anthropicReq.stream) openaiReq.stream_options = { include_usage: true };
  const port = await ensureUpstream();
  const outBody = JSON.stringify(openaiReq);

  forwardToUpstream(port, '/chat/completions', 'POST', {}, outBody, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      return sendJSON(res, 502, { type: 'error', error: { type: 'api_error', message: 'DuMate upstream unavailable' } });
    }

    if (anthropicReq.stream) {
      // Translate OpenAI SSE stream to Anthropic SSE events
      translateStreamToAnthropic(upstreamRes, res, anthropicReq.model);
    } else {
      // Non-streaming: collect and translate
      collectAndFinish(upstreamRes, (data) => {
        try {
          const openaiResp = JSON.parse(data);
          const anthropicResp = openAIToAnthropic(openaiResp, anthropicReq.model);
          sendJSON(res, 200, anthropicResp);
        } catch (e) {
          sendJSON(res, 502, { type: 'error', error: { type: 'api_error', message: 'Upstream parse error: ' + data.substring(0, 200) } });
        }
      });
    }
  });
}

// Translate OpenAI SSE stream to Anthropic SSE stream
function translateStreamToAnthropic(upstreamRes, res, originalModel) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send message_start
  const msgId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 8);
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: originalModel || 'claude-3-5-sonnet-20241022',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  let buffer = '';
  let blockIndex = -1;
  let currentBlockType = null; // 'thinking' or 'text'
  let hasText = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastFinishReason = null;

  upstreamRes.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.substring(6).trim();
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);
        if (chunk.usage) {
          if (chunk.usage.prompt_tokens != null) inputTokens = chunk.usage.prompt_tokens;
          if (chunk.usage.completion_tokens != null) outputTokens = chunk.usage.completion_tokens;
        }
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (!delta) continue;

        // Reasoning content -> thinking block
        if (delta.reasoning_content) {
          if (currentBlockType !== 'thinking') {
            // Close previous block
            if (blockIndex >= 0) {
              sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            }
            blockIndex++;
            currentBlockType = 'thinking';
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'thinking', thinking: '' }
            });
          }
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
          });
        }

        // Content -> text block
        if (delta.content) {
          if (currentBlockType !== 'text') {
            if (blockIndex >= 0) {
              sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            }
            blockIndex++;
            currentBlockType = 'text';
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' }
            });
          }
          hasText = true;
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: delta.content }
          });
        }

        // Finish reason
        const finishReason = chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason;
        if (finishReason) lastFinishReason = finishReason;
      } catch (e) {
        // ignore parse errors
      }
    }
  });

  upstreamRes.on('end', () => {
    // Close any open block
    if (blockIndex >= 0) {
      sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }
    // If no content was generated, add an empty text block
    if (!hasText && blockIndex < 0) {
      sendEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      });
      sendEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '' }
      });
      sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
    }
    sendEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(lastFinishReason), stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    });
    sendEvent('message_stop', { type: 'message_stop' });
    res.end();
  });

  upstreamRes.on('error', () => {
    sendEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(lastFinishReason), stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    });
    sendEvent('message_stop', { type: 'message_stop' });
    res.end();
  });
}

// ==================== Server ====================

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  try {
    // Health check
    if (url === '/health' || url === '/ping') {
      return sendJSON(res, 200, {
        status: 'ok',
        upstream_port: upstreamPort,
        upstream_managed: upstreamManaged,
        service: 'dumate2api',
      });
    }

    // ==================== OpenAI compatible ====================
    // Models list
    if (url === '/v1/models' && req.method === 'GET') {
      return handleOpenAIModels(req, res);
    }

    // Chat completions (OpenAI format, pass-through with model mapping)
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      return handleOpenAIChat(req, res);
    }

    // Responses API (Codex CLI 0.155+ 只认 wire_api="responses")
    if ((url === '/v1/responses' || url === '/responses') && req.method === 'POST') {
      return handleOpenAIResponses(req, res);
    }

    // ==================== Google Generative Language compatible ====================
    const googleModels = url.match(/^\/v1beta\/models$/);
    const googleGenerate = url.match(/^\/v1beta\/models\/([^:/?]+):(generateContent|streamGenerateContent)$/);
    if (googleModels && req.method === 'GET') {
      return handleGoogleModels(req, res);
    }
    if (googleGenerate && req.method === 'POST') {
      return handleGoogleGenerateContent(req, res, googleGenerate[2] === 'streamGenerateContent');
    }

    // ==================== Anthropic compatible ====================
    // Messages (Anthropic format, full translation)
    // Some clients (Claude Code / cc-switch) hit the bare path, others the
    // /v1-prefixed one. Accept both.
    if ((url === '/v1/messages' || url === '/messages') && req.method === 'POST') {
      return handleAnthropicMessages(req, res);
    }

    // Also support /v1/chat/completions for Anthropic-style path
    if (url === '/api/v1/messages' && req.method === 'POST') {
      return handleAnthropicMessages(req, res);
    }

    if ((url === '/v1/messages/count_tokens' || url === '/messages/count_tokens' || url === '/api/v1/messages/count_tokens') && req.method === 'POST') {
      return handleAnthropicCountTokens(req, res);
    }

    // 404
    sendJSON(res, 404, { error: { message: `Not found: ${url}`, type: 'invalid_request_error' } });
  } catch (err) {
    log('Error:', err.message);
    sendJSON(res, 500, { error: { message: err.message, type: 'api_error' } });
  }
});

// Initial discovery and start
async function start() {
  log('Starting dumate2api...');
  log(`Proxy will listen on ${PROXY_HOST}:${PROXY_PORT}`);

  try {
    const port = await discoverPort();
    if (port) {
      const valid = await verifyPort(port);
      if (valid) {
        upstreamPort = port;
        upstreamManaged = port === require('./discovery').MANAGED_PORT && (process.env.DUMATE_AUTOSTART || 'auto') !== 'off';
        lastDiscoveryTime = Date.now();
        log(`✓ DuMate main-server verified on port ${port}` + (upstreamManaged ? ' (headless, no DuMate GUI needed)' : ''));
      } else {
        log(`⚠ Found dumate-main-server on port ${port} but endpoint verification failed`);
        upstreamPort = port; // still try to use it
        lastDiscoveryTime = Date.now();
      }
    } else {
      log('⚠ DuMate main-server not detected. Will retry on first request.');
      log('  Make sure DuMate desktop app is running and logged in.');
    }
  } catch (e) {
    log('⚠ Initial discovery failed:', e.message);
  }

  server.listen(PROXY_PORT, PROXY_HOST, () => {
    log(`✓ dumate2api listening on http://${PROXY_HOST}:${PROXY_PORT}`);
    log('');
    log('Endpoints:');
    log('  OpenAI:    http://127.0.0.1:' + PROXY_PORT + '/v1/chat/completions');
    log('  Models:    http://127.0.0.1:' + PROXY_PORT + '/v1/models');
    log('  Anthropic: http://127.0.0.1:' + PROXY_PORT + '/v1/messages');
    log('  Health:    http://127.0.0.1:' + PROXY_PORT + '/health');
    log('');
    log('cc-switch configuration:');
    log('  Claude Code: Base URL = http://127.0.0.1:' + PROXY_PORT + ', API Key = nokey');
    log('  Codex:       Base URL = http://127.0.0.1:' + PROXY_PORT + '/v1, API Key = nokey');
  });
}

start().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
