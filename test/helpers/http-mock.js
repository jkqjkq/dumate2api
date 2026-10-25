// test/helpers/http-mock.js - 假上游 HTTP 服务器（给通道/网关类测试用）
//
// 与 test/mock-upstream.js 的区别：mock-upstream 是给真机冒烟（smoke.js）
// 用的常驻进程，模拟的是 DuMate qianfanproxy 的固定行为；本 helper 是
// node:test 内嵌的一次性服务器——每个测试用例自己起、自己关，随机端口，
// 行为由用例当场给定。需要测「上游 502 / SSE 半途掐断 / 慢响应」之类的
// 行为测试时用它，不需要真机凭证、不出网。
//
// 用法：
//   const { startHttp } = require('./helpers/http-mock');
//   const upstream = await startHttp((req, res, body) => {
//     res.writeHead(429, { 'Content-Type': 'application/json' });
//     res.end(JSON.stringify({ code: 429, message: 'rate limited' }));
//   });
//   // ...把 upstream.url 指给被测代码，断言其行为...
//   await upstream.close();
//
// handler 收到的 body 是完整 Buffer（data/end 已收拢），抛错会转 500，
// 避免用例里一个笔误变成悬挂请求。

const http = require('http');

/**
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse, body: Buffer) => void} handler
 * @param {{host?: string}} [opts]
 */
function startHttp(handler, opts = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        handler(req, res, body);
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
  });
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, opts.host || '127.0.0.1', () => resolve());
  });
  return listening.then(() => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
      server,
      port,
      url: `http://${opts.host || '127.0.0.1'}:${port}`,
      /** 请求计数，供用例断言「上游被调了两次」之类 */
      hits: 0,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }).then((srv) => {
    // hits 在 createServer 回调里自增需要闭包先存在，这里挂一层包装
    const raw = srv.server;
    raw.on('request', () => { srv.hits += 1; });
    return srv;
  });
}

module.exports = { startHttp };
