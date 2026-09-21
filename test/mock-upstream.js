// test/mock-upstream.js - Mock DuMate qianfanproxy upstream for offline verification
const http = require('http');
const PORT = parseInt(process.env.MOCK_PORT || '52890', 10);

function sse(res, chunk) {
  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
}

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/api/qianfanproxy/v1')) {
    res.writeHead(404); return res.end('{}');
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const auth = req.headers['authorization'] || '';
    if (!auth.includes('nokey')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad key' } }));
    }
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (e) {}

    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const id = 'chatcmpl-mock';
        sse(res, { id, object: 'chat.completion.chunk', created: 1, model: parsed.model,
          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Let me think.' }, finish_reason: null }] });
        sse(res, { id, object: 'chat.completion.chunk', created: 1, model: parsed.model,
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] });
        sse(res, { id, object: 'chat.completion.chunk', created: 1, model: parsed.model,
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] });
        sse(res, { id, object: 'chat.completion.chunk', created: 1, model: parsed.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        if (parsed.stream_options && parsed.stream_options.include_usage) {
          sse(res, { id, object: 'chat.completion.chunk', created: 1, model: parsed.model,
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello world', reasoning_content: 'Let me think.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      }));
    }
    // models endpoint for verification
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'model-text' }] }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log('mock upstream on ' + PORT));
