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
