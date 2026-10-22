// test/verify-qoder-channel.js - Qoder 通道的离线验证
//
// 不依赖网络与运行中的服务。覆盖三块：
//   1. 模型倍率解析（price_factor 排序、cheap 判定、兜底表）
//   2. 聊天 body 构造（模型 key 同时进 body 与请求头、工具过滤、执行纪律注入）
//   3. 上游响应解析（信封错误、usage 里的 credits、SSE 聚合）
//
// 为什么不测签名：那是 verify-qoder-cosy.js 的事（用 Go 参考实现的测试向量）。
const assert = require('assert');
const chat = require('../src/qoder/chat');
const constants = require('../src/qoder/constants');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}

console.log('== 模型 key 解析 ==');
check('未知名字原样透传', () => assert.strictEqual(chat.resolveModelKey('gfmodel'), 'gfmodel'));
check('别名 qwen-max → qmodel_latest', () => assert.strictEqual(chat.resolveModelKey('qwen-max'), 'qmodel_latest'));
check('空值回落默认 auto', () => assert.strictEqual(chat.resolveModelKey(''), constants.DEFAULT_MODEL));

// 真实模型名解析：上游 key 是内部代号，cc-switch 里填它分不清是哪个模型，
// 所以 display_name / 归一化写法都要能解析回 key
const MODELS = [
  { key: 'gfmodel', name: 'GLM-5.3-Flash' },
  { key: 'dmodel', name: 'DeepSeek-V4-Pro' },
  { key: 'kmodel', name: 'Kimi-K2.8-Preview' },
  { key: 'auto', name: 'Auto' },
];
check('真实名 → 内部 key', () => assert.strictEqual(chat.resolveModelKey('qoder/GLM-5.3-Flash', MODELS), 'gfmodel'));
check('真实名大小写不敏感', () => assert.strictEqual(chat.resolveModelKey('glm-5.3-flash', MODELS), 'gfmodel'));
check('去掉分隔符也能匹配', () => assert.strictEqual(chat.resolveModelKey('qoder/glm53flash', MODELS), 'gfmodel'));
check('内部 key 仍可用（旧配置不破坏）', () => assert.strictEqual(chat.resolveModelKey('qoder/gfmodel', MODELS), 'gfmodel'));
check('相近名字不串档（Pro ≠ Flash）', () => assert.strictEqual(chat.resolveModelKey('qoder/DeepSeek-V4-Pro', MODELS), 'dmodel'));
check('未知名字仍原样透传', () => assert.strictEqual(chat.resolveModelKey('qoder/nope', MODELS), 'nope'));

console.log('');
console.log('== 聊天 body 构造 ==');
const body = JSON.parse(chat.buildBody('gfmodel', {
  model: 'qoder/gfmodel',
  messages: [{ role: 'user', content: '你好' }],
  max_tokens: 100,
}));
check('model_config.key 是模型名', () => assert.strictEqual(body.model_config.key, 'gfmodel'));
check('chat_context.extra.modelConfig.key 同步', () => assert.strictEqual(body.chat_context.extra.modelConfig.key, 'gfmodel'));
check('stream 为 true（上游只走 SSE）', () => assert.strictEqual(body.stream, true));
check('带 business 对象（缺了会 503）', () => assert.strictEqual(body.business.product, 'qoder_work'));
check('session_type 正确', () => assert.strictEqual(body.session_type, 'qoder_work'));
check('max_tokens 透传', () => assert.strictEqual(body.parameters.max_tokens, 100));
check('chat_context.text 取最后一条 user', () => assert.strictEqual(body.chat_context.text, '你好'));

console.log('');
console.log('== 工具过滤（上游只认标准 function 形状）==');
const withTools = JSON.parse(chat.buildBody('gfmodel', {
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { type: 'function', function: { name: 'exec_command', parameters: {} } },
    { type: 'namespace', name: 'multi_agent_v1' },   // Codex 会带，必须丢弃
    { type: 'web_search' },                          // 同上
  ],
}));
check('只保留 function 形状', () => assert.strictEqual(withTools.tools.length, 1));
check('保留的是 exec_command', () => assert.strictEqual(withTools.tools[0].function.name, 'exec_command'));

console.log('');
console.log('== 执行纪律注入 ==');
check('有工具时注入', () => {
  const b = JSON.parse(chat.buildBody('gfmodel', {
    system: '你是助手',
    messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
  }));
  assert.ok(b.system.includes('【执行纪律'));
});
check('无工具时不注入（纯对话不该干扰）', () => {
  const b = JSON.parse(chat.buildBody('gfmodel', {
    system: '你是助手',
    messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }],
  }));
  assert.ok(!b.system.includes('【执行纪律'));
});
check('幂等：重复注入不叠加', () => {
  const once = chat.withAgentDiscipline('X', true);
  const twice = chat.withAgentDiscipline(once, true);
  assert.strictEqual(once, twice);
});
check('system 留在 messages 里（上游只认它）', () => {
  const b = JSON.parse(chat.buildBody('gfmodel', {
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
  }));
  assert.ok(b.messages.some((m) => m.role === 'system' && m.content.includes('SYS')));
});

console.log('');
console.log('== 响应解析 ==');
check('unwrap 剥信封', () => {
  const inner = '{"choices":[{"delta":{"content":"hi"}}]}';
  const outer = JSON.stringify({ body: inner, statusCodeValue: 200 });
  assert.deepStrictEqual(chat.unwrap(outer), [inner]);
});
check('envelopeStatus 抓业务错误', () => {
  const outer = JSON.stringify({ body: '{"code":"105","message":"Login expired"}', statusCodeValue: 403 });
  const es = chat.envelopeStatus(`data:${outer}`);
  assert.strictEqual(es.code, 403);
  assert.ok(es.message.includes('Login expired'));
});
check('payloadError 抓内层错误码', () => {
  const e = chat.payloadError({ code: 500, message: 'boom' });
  assert.strictEqual(e.code, 500);
});
check('正常帧不误判为错误', () => {
  assert.strictEqual(chat.payloadError({ choices: [{ delta: { content: 'hi' } }] }), null);
});

// 2026-10-22：上游 provider 层失败时发的是**字符串 code**，且首字母小写。
// 旧判据只认 /^[A-Z]/，这一帧被当正常数据转发 → 翻译器没有 choices 可读 →
// 客户端拿到 200 + 空回答（实测 /v1/responses 只有 created/in_progress/completed）。
check('payloadError 抓 provider_error（小写字符串 code）', () => {
  const e = chat.payloadError({
    code: 'provider_error', message: 'All backends failed',
    request_id: 'x', type: 'provider_error',
  });
  assert.ok(e, '必须判定为错误');
  assert.ok(e.message.includes('All backends failed'));
});
check('payloadError 抓 type=provider_error（无 code）', () => {
  const e = chat.payloadError({ type: 'provider_error', message: 'All backends failed' });
  assert.ok(e);
});
check('payloadError 的 error 对象优先于 type（不产出 [object Object]）', () => {
  const e = chat.payloadError({ type: 'error', error: { code: 503, message: 'All backends failed' } });
  assert.ok(e, '必须判定为错误');
  assert.strictEqual(e.code, 503);
  assert.ok(e.message.includes('All backends failed'), e.message);
  assert.ok(!e.message.includes('[object Object]'), e.message);
});
check('payloadError 抓 error 对象', () => {
  const e = chat.payloadError({ error: { code: 503, message: 'unavailable' } });
  assert.strictEqual(e.code, 503);
});
check('payloadError 仍认大写字符串 code', () => {
  const e = chat.payloadError({ code: 'LoginExpired', message: 'login expired' });
  assert.ok(e);
});
check('payloadError 不误伤 code=0 / 成功标记', () => {
  assert.strictEqual(chat.payloadError({ code: 0, message: 'ok' }), null);
  assert.strictEqual(chat.payloadError({ code: '0' }), null);
  assert.strictEqual(chat.payloadError({ code: 'success' }), null);
});
check('envelopeStatus 抓非信封的纯错误体', () => {
  const es = chat.envelopeStatus('{"code":"provider_error","message":"All backends failed","type":"provider_error"}');
  assert.ok(es, '非 SSE 的错误体也要认');
  assert.ok(es.message.includes('All backends failed'));
});

console.log('');
console.log('== SSE 聚合（含 usage 里的 credits）==');
const agg = chat.aggregate([
  '{"id":"x","choices":[{"delta":{"reasoning_content":"想"}}]}',
  '{"choices":[{"delta":{"content":"你"}}]}',
  '{"choices":[{"delta":{"content":"好"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"credits":0.0065},"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}',
], 'gfmodel');
check('正文拼接', () => assert.strictEqual(agg.choices[0].message.content, '你好'));
check('reasoning 拼接', () => assert.strictEqual(agg.choices[0].message.reasoning_content, '想'));
check('usage 里的 credits 保留', () => assert.strictEqual(agg.usage.credits, 0.0065));
check('finish_reason 透传', () => assert.strictEqual(agg.choices[0].finish_reason, 'stop'));

console.log('');
console.log('== 常量 ==');
check('两个区域都有端点', () => {
  assert.ok(constants.endpointsOf('cn').ChatStreamURL.includes('qoder.com.cn'));
  assert.ok(constants.endpointsOf('global').ChatStreamURL.includes('qoder.sh'));
});
check('区域归一化', () => {
  assert.strictEqual(constants.normalizeRegion('cn'), 'cn');
  assert.strictEqual(constants.normalizeRegion('CN'), 'cn');
  assert.strictEqual(constants.normalizeRegion(''), 'global');
  assert.strictEqual(constants.normalizeRegion('us'), 'global');
});
check('便宜模型表都是 0.1 档', () => {
  assert.deepStrictEqual(constants.CHEAP_MODELS, ['qfmodel', 'qmodel', 'q37fmodel', 'dfmodel', 'gfmodel']);
});

console.log('');
if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
console.log('全部通过');
process.exit(0);
