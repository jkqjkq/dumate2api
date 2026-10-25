// test/cors.test.js - cors.js 行为测试（审计 P0-1 的 fail-closed 语义）
//
// cors.js 在 require 时固化 DUMATE_CORS_ORIGINS 白名单，所以要测不同配置
// 必须「设 env → 清缓存重载」（tmpdata.reload）。覆盖三类语义：
//   1. 未配置 → 不发任何 ACAO 头（浏览器跨域在 preflight 就被拦）
//   2. 配置含字面 "*" → fail-closed，按未配置处理，绝不退化回全开
//   3. 白名单 → 仅回显命中的 Origin，*.example.com 支持子域通配
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reload } = require('./helpers/tmpdata');

const corsPath = require.resolve('../src/cors');

function loadWith(envVal) {
  if (envVal === undefined) delete process.env.DUMATE_CORS_ORIGINS;
  else process.env.DUMATE_CORS_ORIGINS = envVal;
  return reload(corsPath);
}

const reqWith = (origin) => ({ headers: origin ? { origin } : {} });

test('未配置：无 Origin 头的请求（CLI/同源）零 CORS 头', () => {
  const cors = loadWith(undefined);
  assert.deepEqual(cors.headersFor(reqWith(null)), {});
  assert.equal(cors.allowlistSize(), 0);
});

test('未配置：带 Origin 的跨域请求只回 Vary，不发 ACAO（fail-closed）', () => {
  const cors = loadWith(undefined);
  const h = cors.headersFor(reqWith('https://evil.example'));
  assert.deepEqual(h, { Vary: 'Origin' });
  assert.ok(!('Access-Control-Allow-Origin' in h));
});

test('字面 "*"：fail-closed，按未配置处理', () => {
  const cors = loadWith('*');
  assert.equal(cors.allowlistSize(), 0);
  const h = cors.headersFor(reqWith('https://evil.example'));
  assert.ok(!('Access-Control-Allow-Origin' in h));
});

test('白名单命中：回显请求的 Origin', () => {
  const cors = loadWith('https://panel.example.com');
  const h = cors.headersFor(reqWith('https://panel.example.com'));
  assert.equal(h['Access-Control-Allow-Origin'], 'https://panel.example.com');
  assert.equal(h.Vary, 'Origin');
});

test('白名单未命中：只回 Vary', () => {
  const cors = loadWith('https://panel.example.com');
  const h = cors.headersFor(reqWith('https://other.example.com'));
  assert.ok(!('Access-Control-Allow-Origin' in h));
  assert.equal(h.Vary, 'Origin');
});

test('子域通配 *.example.com：子域命中、裸域与前后缀伪造不命中', () => {
  const cors = loadWith('*.example.com');
  assert.equal(cors.headersFor(reqWith('https://api.example.com'))['Access-Control-Allow-Origin'], 'https://api.example.com');
  assert.ok(!('Access-Control-Allow-Origin' in cors.headersFor(reqWith('https://example.com'))));
  // endsWith('.example.com')：evilexample.com 不该被放行
  assert.ok(!('Access-Control-Allow-Origin' in cors.headersFor(reqWith('https://evilexample.com'))));
});

test('大小写归一与尾斜杠剥除', () => {
  // 白名单条目小写化、去尾斜杠；请求 Origin 也小写化后比对
  const cors = loadWith('HTTPS://Panel.Example.com/');
  assert.equal(cors.allowlistSize(), 1);
  assert.equal(
    cors.headersFor(reqWith('https://PANEL.example.COM'))['Access-Control-Allow-Origin'],
    'https://PANEL.example.COM' // 回显的是请求原串（String(origin)），比对在小写域完成
  );
});

test('多 Origin 白名单：逗号分隔，逐条判定', () => {
  const cors = loadWith('https://a.example.com, https://b.example.com,,');
  assert.equal(cors.allowlistSize(), 2);
  assert.ok(cors.headersFor(reqWith('https://b.example.com'))['Access-Control-Allow-Origin']);
  assert.ok(!('Access-Control-Allow-Origin' in cors.headersFor(reqWith('https://c.example.com'))));
});

test('响应头零变化原则：无 Origin 零头、未命中只 Vary、命中加 ACAO', () => {
  const cors = loadWith('https://a.example.com');
  // 无 Origin 头（CLI/同源）→ 空对象，响应头零变化（连 Vary 都不发）
  assert.deepEqual(cors.headersFor(reqWith(null)), {});
  // 跨域未命中 → 只有 Vary
  assert.deepEqual(cors.headersFor(reqWith('https://nope.example.com')), { Vary: 'Origin' });
  // 命中 → Vary + 回显 Origin
  const hit = cors.headersFor(reqWith('https://a.example.com'));
  assert.equal(hit.Vary, 'Origin');
  assert.equal(hit['Access-Control-Allow-Origin'], 'https://a.example.com');
});
