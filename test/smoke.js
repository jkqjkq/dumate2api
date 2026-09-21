const http = require('http');

function req(method, path, body, headers) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body);
    const h = { 'Content-Type': 'application/json', ...headers };
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: 9080, path, method, headers: h }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out, ct: res.headers['content-type'] }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message), ct: '' }));
    if (data) r.write(data);
    r.end();
  });
}

const ANTH = { 'x-api-key': 'nokey', 'anthropic-version': '2023-06-01' };
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

(async () => {
  console.log('--- OpenAI ---');
  let r = await req('GET', '/v1/models');
  check('models 200', r.status === 200, r.body);
  check('models has model-text', r.body.includes('model-text'));

  r = await req('POST', '/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  check('oai non-stream 200', r.status === 200, r.body);
  check('oai maps gpt-4o -> model-text', JSON.parse(r.body).model === 'model-text');

  r = await req('POST', '/v1/chat/completions', { model: 'glm-5', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  check('oai stream sse', r.ct && r.ct.includes('text/event-stream'), r.ct);
  check('oai stream has [DONE]', r.body.includes('[DONE]'));

  console.log('--- Anthropic ---');
  r = await req('POST', '/v1/messages', { model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, ANTH);
  check('anth non-stream 200', r.status === 200, r.body);
  let j = JSON.parse(r.body);
  check('anth type=message', j.type === 'message');
  check('anth stop_reason end_turn', j.stop_reason === 'end_turn');
  check('anth thinking block', j.content.some((b) => b.type === 'thinking'));
  const textBlock = j.content.find((b) => b.type === 'text');
  check('anth text block present', !!textBlock, JSON.stringify(j.content));
  check('anth text non-empty', !!textBlock && textBlock.text.length > 0, textBlock && textBlock.text);
  check('anth usage input > 0', j.usage.input_tokens > 0, JSON.stringify(j.usage));
  check('anth usage output > 0', j.usage.output_tokens > 0, JSON.stringify(j.usage));

  r = await req('POST', '/v1/messages', { model: 'claude-3-5-sonnet-20241022', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }, ANTH);
  check('anth stream sse', r.ct && r.ct.includes('text/event-stream'), r.ct);
  check('anth stream message_start', r.body.includes('event: message_start'));
  check('anth stream message_stop', r.body.includes('event: message_stop'));
  const mdBlock = r.body.split('\n\n').filter((b) => b.includes('event: message_delta')).pop() || '';
  const md = mdBlock.match(/"usage":\{"input_tokens":(\d+),"output_tokens":(\d+)\}/);
  check('anth stream has usage', !!md, r.body.match(/message_delta[\s\S]{0,200}/));
  check('anth stream input_tokens > 0', !!md && Number(md[1]) > 0, md && md[1]);
  check('anth stream output_tokens > 0', !!md && Number(md[2]) > 0, md && md[2]);
  const iStop = r.body.lastIndexOf('content_block_stop');
  const iDelta = r.body.lastIndexOf('event: message_delta');
  check('block_stop precedes message_delta', iStop !== -1 && iDelta !== -1 && iStop < iDelta);
  check('exactly one message_delta', (r.body.match(/event: message_delta/g) || []).length === 1);

  console.log('--- multi-turn / system / tools ---');
  r = await req('POST', '/v1/chat/completions', {
    model: 'model-text',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ],
  });
  check('multi-turn passthrough 200', r.status === 200, r.body);

  r = await req('POST', '/v1/messages', {
    model: 'claude-3-5-sonnet-20241022',
    system: [{ type: 'text', text: 'sys-a' }, { type: 'text', text: 'sys-b' }],
    max_tokens: 10,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] },
    ],
  }, ANTH);
  check('complex anth req 200', r.status === 200, r.body);

  console.log('--- count_tokens ---');
  r = await req('POST', '/v1/messages/count_tokens', { model: 'model-text', messages: [{ role: 'user', content: 'hi' }] }, ANTH);
  check('count_tokens 200', r.status === 200, r.body);
  check('count_tokens type', JSON.parse(r.body).type === 'count_tokens_result');
  r = await req('POST', '/messages/count_tokens', { model: 'model-text', messages: [] }, ANTH);
  check('count_tokens bare path 200', r.status === 200, r.body);

  console.log('--- errors ---');
  r = await req('POST', '/v1/messages', null, ANTH);
  check('anth empty body 400', r.status === 400, r.body);
  r = await req('POST', '/v1/chat/completions', null, {});
  check('oai empty body 400', r.status === 400, r.body);
  r = await req('GET', '/v1/nope');
  check('404', r.status === 404, r.body);
  r = await req('GET', '/health');
  check('health 200', r.status === 200, r.body);
  const h = JSON.parse(r.body);
  check('health reports upstream', h.upstream_port === 8980 || h.upstream_port === 52890, r.body);

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})();