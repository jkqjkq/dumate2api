// test/unit/stream-error-surface.test.js - 上游错误必须把**真实原因**交给客户端
//
// 背景（2026-10-27）：Qoder 排队限流时，上游在出任何内容之前就失败。
// Responses 翻译器原来硬编码 `error.message = 'upstream stream error'` 且
// `finish(502)`，于是：
//   - Codex 只看到「上游流错误」，分不清是排队、额度还是凭证失效；
//   - 埋点里所有直连通道的失败都是 502，按状态码归因失效。
// 现在改成透传 `e.message` 与 `e.statusCode`，并把 429 映射成
// `rate_limit_exceeded`（Codex 据此退避重试）。
//
// Anthropic 那条（server.js 的 translateStreamToAnthropic）改成发 SSE 的
// `event: error`，但它是脚本内函数、不可 require，因此只在 CLAUDE.md 里记录，
// 由实机验证覆盖（`event: error` + 真实 message）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { translateStreamToResponses } = require('../../src/responses');

function runWith(upstreamError) {
  return new Promise((resolve) => {
    const up = new PassThrough();
    const res = {
      headersSent: false,
      writeHead() { this.headersSent = true; },
      write() { return true; },
      end() { this.ended = true; },
    };
    const events = [];
    res.write = (s) => { events.push(String(s)); return true; };
    let doneArgs = null;
    translateStreamToResponses(up, res, 'qoder/DeepSeek-Flash', (usage, status, extra) => {
      doneArgs = { usage, status, extra };
      resolve({ events, doneArgs });
    });
    up.emit('error', upstreamError);
  });
}

function failedPayload(events) {
  const line = events.join('').split('\n').find((l) => l.includes('"type":"response.failed"'));
  return line ? JSON.parse(line.replace(/^data:\s*/, '')) : null;
}

test('429：response.failed 透传真实原因，code=rate_limit_exceeded，埋点记 429', async () => {
  const err = new Error('Qoder 上游限流，全部账号排队中（30 秒后可重试）');
  err.statusCode = 429;
  const { events, doneArgs } = await runWith(err);
  const f = failedPayload(events);
  assert.ok(f, '必须发 response.failed');
  assert.equal(f.response.status, 'failed');
  assert.equal(f.response.error.code, 'rate_limit_exceeded');
  assert.match(f.response.error.message, /限流/, '真实原因不能被抹成 "upstream stream error"');
  assert.equal(doneArgs.status, 429, '埋点状态码必须是 429（不能写死 502）');
});

test('5xx：code=server_error，埋点透传状态码', async () => {
  const err = new Error('qoder 500: provider_error: Error in upstream response');
  err.statusCode = 500;
  const { events, doneArgs } = await runWith(err);
  const f = failedPayload(events);
  assert.equal(f.response.error.code, 'server_error');
  assert.match(f.response.error.message, /provider_error/);
  assert.equal(doneArgs.status, 500);
});

test('没有 statusCode 的网络错误：回落 502，但仍带上真实 message', async () => {
  const { events, doneArgs } = await runWith(new Error('socket hang up'));
  const f = failedPayload(events);
  assert.equal(f.response.error.code, 'server_error');
  assert.match(f.response.error.message, /socket hang up/);
  assert.equal(doneArgs.status, 502);
});
