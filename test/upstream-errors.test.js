// test/upstream-errors.test.js - upstream-errors.js 行为测试（COSY 协议栈错误识别）
//
// 用例直接取自模块头注释里的实测错误形状。核心判据：
//   - 数字 code >= 400 / 纯数字字符串 code >= 400
//   - 非数字字符串 code（含小写 provider_error）只要带 message/type 就认
//   - error 对象**先于** type 判（旧实现的 [object Object] 事故）
//   - code: 0 / 'success' 等成功标记与正常数据帧不误伤
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { payloadError, envelopeStatus } = require('../src/upstream-errors');

test('payloadError：非对象输入返回 null', () => {
  assert.equal(payloadError(null), null);
  assert.equal(payloadError('str'), null);
  assert.equal(payloadError(42), null);
});

test('payloadError：数字 code >= 400 识别，message 从 message/msg/error 提取', () => {
  assert.deepEqual(payloadError({ code: 403, message: 'forbidden' }), { code: 403, message: 'forbidden' });
  assert.deepEqual(payloadError({ code: 503, msg: 'busy' }), { code: 503, message: 'busy' });
  assert.equal(payloadError({ code: 200, message: 'ok' }), null, '2xx 不是错误');
  assert.equal(payloadError({ code: 399, message: 'odd' }), null);
});

test('payloadError：字符串数字 code 按数字判', () => {
  assert.deepEqual(payloadError({ code: '403', message: 'Model is not available for this user' }),
    { code: 403, message: 'Model is not available for this user' });
  assert.equal(payloadError({ code: '200', message: 'ok' }), null);
});

test('payloadError：小写字符串 code（provider_error）也认——旧判据只认大写首字母的事故', () => {
  assert.deepEqual(
    payloadError({ code: 'provider_error', message: 'All backends failed', type: 'provider_error' }),
    { code: 500, message: 'provider_error: All backends failed' }
  );
  // 无 message 但有 type 也认
  assert.deepEqual(payloadError({ code: 'LoginExpired', type: 'auth_error' }),
    { code: 500, message: 'LoginExpired' });
  // 无 message 也无 type 的裸字符串 code 不认（避免误伤）
  assert.equal(payloadError({ code: 'weird-token' }), null);
});

test('payloadError：error 对象先于 type 判（[object Object] 事故回归）', () => {
  assert.deepEqual(
    payloadError({ type: 'error', error: { code: 503, message: 'backend down' } }),
    { code: 503, message: 'backend down' }
  );
  // error.code 不是 >=400 的数字时兜底 500，不丢错误
  assert.deepEqual(
    payloadError({ error: { code: 'oops', message: 'broken' } }),
    { code: 500, message: 'broken' }
  );
});

test('payloadError：type 形状错误（无 code）', () => {
  assert.deepEqual(
    payloadError({ type: 'provider_error', message: 'upstream boom' }),
    { code: 500, message: 'provider_error: upstream boom' }
  );
  assert.deepEqual(
    payloadError({ type: 'error', message: 'plain' }),
    { code: 500, message: 'error: plain' }
  );
  assert.equal(payloadError({ type: 'chat.completion.chunk', message: 'normal' }), null,
    '正常帧的 type 不该被当错误');
});

test('payloadError：成功标记与正常数据帧不误伤', () => {
  assert.equal(payloadError({ code: 0 }), null);
  assert.equal(payloadError({ code: 'success' }), null);
  assert.equal(payloadError({ choices: [{ delta: { content: 'hi' } }], usage: {} }), null);
  assert.equal(payloadError({}), null);
});

test('envelopeStatus：statusCodeValue >= 400 信封（body 是 JSON 串）', () => {
  const raw = JSON.stringify({
    statusCodeValue: 403, statusCode: 'Forbidden',
    body: JSON.stringify({ code: '403', message: 'Model is not available for this user' }),
  });
  assert.deepEqual(envelopeStatus(raw), { code: 403, message: 'Model is not available for this user' });
});

test('envelopeStatus：data: 前缀逐行剥除（早期整体 parse 必败被吞成 null 的事故）', () => {
  const inner = JSON.stringify({ statusCodeValue: 429, body: '{"message":"rate"}' });
  const raw = `data:${inner}\ndata:[DONE]\n`;
  assert.deepEqual(envelopeStatus(raw), { code: 429, message: 'rate' });
});

test('envelopeStatus：非 SSE 裸错误体（外层就是 payloadError 形状）', () => {
  assert.deepEqual(
    envelopeStatus(JSON.stringify({ code: 429, message: 'too many' })),
    { code: 429, message: 'too many' }
  );
});

test('envelopeStatus：信封 200 但内层带错误 code', () => {
  const raw = JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify({ code: 500, message: 'inner boom' }),
  });
  assert.deepEqual(envelopeStatus(raw), { code: 500, message: 'inner boom' });
});

test('envelopeStatus：正常数据 / 空串 / 非 JSON 返回 null', () => {
  assert.equal(envelopeStatus(''), null);
  assert.equal(envelopeStatus(null), null);
  assert.equal(envelopeStatus('data:[DONE]\n'), null);
  assert.equal(envelopeStatus('plain text not json'), null);
  assert.equal(
    envelopeStatus(JSON.stringify({ statusCodeValue: 200, body: 'ok' })),
    null
  );
});

test('envelopeStatus：body 不是 JSON 时 message 回落为 body 截断 200', () => {
  const raw = JSON.stringify({ statusCodeValue: 502, body: 'gateway died badly' });
  assert.deepEqual(envelopeStatus(raw), { code: 502, message: 'gateway died badly' });
});

// ---------------------------------------------------------------------------
// classify：code → 池处置类别（GAP Q3）。集成阶段校准点：
// model 字段必须原样透传——池的 model 类别靠它建 (账号,模型) 负缓存，
// 此前被 classify 丢掉，403 模型错误实际退化为熔断计数。
const { classify } = require('../src/upstream-errors');

test('classify：429→soft / 401→session_dead / 402→hard / 403+模型文案→model / 5xx→breaker', () => {
  assert.equal(classify({ status: 429, message: 'too many' }).kind, 'soft');
  assert.equal(classify({ status: 401, message: 'unauthorized' }).kind, 'session_dead');
  assert.equal(classify({ status: 402, message: '积分不足' }).kind, 'hard');
  assert.equal(classify({ status: 403, message: 'Model is not available for this user' }).kind, 'model');
  assert.equal(classify({ status: 500, message: 'boom' }).kind, 'breaker');
  assert.equal(classify({ status: 0, message: 'ECONNREFUSED' }).kind, 'breaker');
  assert.equal(classify({ status: 400, message: 'bad request' }).kind, null);
});

test('classify：model 字段透传（模型级负缓存的数据依赖）', () => {
  const cls = classify({ status: 403, message: 'Model is not available for this user', model: 'pro' });
  assert.equal(cls.kind, 'model');
  assert.equal(cls.model, 'pro');
  // 非 model 类别也带 model（池按 kind 分发，多带的字段无害）
  assert.equal(classify({ status: 429, message: 'x', model: 'glm' }).model, 'glm');
  assert.equal(classify({ status: 500, message: 'x' }).model, undefined);
});
