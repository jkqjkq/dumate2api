const http = require('http');
function req(port, path, body, headers) {
  return new Promise((resolve) => {
    const d = JSON.stringify(body);
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: h }, (res) => {
      let o = ''; res.setEncoding('utf8');
      res.on('data', (c) => (o += c));
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'], body: o }));
    });
    r.on('error', (e) => resolve({ status: 0, ct: '', body: e.message }));
    r.write(d); r.end();
  });
}
(async () => {
  console.log('=== [1] Codex 路径: OpenAI chat/completions (wire_api=chat) ===');
  let r = await req(9080, '/v1/chat/completions',
    { model: 'model-text', messages: [{ role: 'user', content: '用四个字回答：中国的首都是哪里？' }], max_tokens: 120 },
    { Authorization: 'Bearer nokey' });
  let j = JSON.parse(r.body);
  console.log('  status', r.status, '| content:', j.choices && j.choices[0].message.content);

  console.log('\n=== [2] Claude Code 路径: Anthropic /messages (BASE_URL 无 /v1) ===');
  r = await req(9080, '/v1/messages',
    { model: 'model-text', max_tokens: 150, messages: [{ role: 'user', content: '用四个字回答：中国的首都是哪里？' }] },
    { 'x-api-key': 'nokey', 'anthropic-version': '2023-06-01' });
  j = JSON.parse(r.body);
  console.log('  status', r.status, '| type:', j.type, '| stop:', j.stop_reason);
  console.log('  blocks:', (j.content || []).map((b) => b.type).join(', '));
  console.log('  text:', (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
  console.log('  usage:', JSON.stringify(j.usage));

  console.log('\n=== [3] Claude Code 裸路径 /messages ===');
  r = await req(9080, '/messages',
    { model: 'model-text', max_tokens: 60, messages: [{ role: 'user', content: '说OK' }] },
    { 'x-api-key': 'nokey', 'anthropic-version': '2023-06-01' });
  console.log('  status', r.status);

  console.log('\n=== [4] 模型名映射: gpt-4o / claude-3-5-sonnet ===');
  for (const m of ['gpt-4o', 'claude-3-5-sonnet-20241022', 'glm-5']) {
    const rr = await req(9080, '/v1/chat/completions',
      { model: m, messages: [{ role: 'user', content: 'say OK' }], max_tokens: 20 },
      { Authorization: 'Bearer nokey' });
    const jj = JSON.parse(rr.body);
    console.log('  ' + m.padEnd(26), '-> status', rr.status, '| served model:', jj.model);
  }
})();