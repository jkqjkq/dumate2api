// 上下文上限实测探针：往网关发指定 token 量的填充文本，看能否吃下、耗时多少。
// 用法: node probe-ctx.js <model> <目标token>
const http = require('http');
const model = process.argv[2];
const targetTokens = parseInt(process.argv[3], 10);
// 实测约 1.73 字符/token（汉字），取保守值 1.6 以免请求体过大
const chars = Math.round(targetTokens * 1.6);
const filler = '这是一段用于测试上下文长度的填充文本。'.repeat(Math.ceil(chars / 19));
const body = JSON.stringify({
  model,
  max_tokens: 32,
  messages: [{ role: 'user', content: filler + '\n\n以上是填充。只回复两个字：收到' }],
});
const t0 = Date.now();
const req = http.request(
  {
    host: '127.0.0.1', port: 9080, path: '/v1/chat/completions', method: 'POST',
    timeout: 900000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  },
  (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { b += c; });
    res.on('end', () => {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      let out = `HTTP ${res.statusCode} | ${secs}s`;
      try {
        const j = JSON.parse(b);
        const c = (j.choices || [])[0] || {};
        const txt = ((c.message || {}).content || '').slice(0, 30);
        out += ` | prompt_tokens=${(j.usage || {}).prompt_tokens} | text=${JSON.stringify(txt)}`;
      } catch (e) {
        out += ` | 非 JSON: ${b.slice(0, 120)}`;
      }
      console.log(`${model} @ ${targetTokens} tok → ${out}`);
    });
  },
);
req.on('error', (e) => console.log(`${model} @ ${targetTokens} tok → ERR ${e.message}`));
req.on('timeout', () => { req.destroy(); console.log(`${model} @ ${targetTokens} tok → TIMEOUT(>15min)`); });
req.write(body);
req.end();
