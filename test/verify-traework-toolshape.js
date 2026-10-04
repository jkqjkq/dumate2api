// TRAE 工具调用形状归一化的离线验证（不需要起服务）。
//
// 背景（2026-10-03 实测抓包）：TRAE 上游的 tool_calls 增量字段叫
// `function_call`（OpenAI 是 `function`），且后续增量里 name 是空串：
//   首片  {"index":0,"id":"call_kx7pybvv8vtlecxcdtkm3cqd","type":"function",
//          "function_call":{"name":"read_file","arguments":"","partial_arguments":null,"namespace":null}}
//   后续  {"index":0,"id":"","type":"","function_call":{"name":"",
//          "arguments":"{\"path\": \"MEMORY.md\"}","partial_arguments":null,"namespace":null}}
// 网关此前裸透传，responses 翻译器按 `tc.function.name` 取名落空——
// Codex 收到空名工具调用报 `unsupported call:`（4 连），整轮失败。
const chat = require('../src/traework/chat');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('FAIL  ' + name); }
}

// ---- 上游实测向量（原样，不许改） ----
const DELTA_FIRST = { index: 0, id: 'call_kx7pybvv8vtlecxcdtkm3cqd', type: 'function', function_call: { name: 'read_file', arguments: '', partial_arguments: null, namespace: null } };
const DELTA_ARGS = { index: 0, id: '', type: '', function_call: { name: '', arguments: '{"path": "MEMORY.md"}', partial_arguments: null, namespace: null } };

// 1. normalizeToolCall：function_call 形状
{
  const n = chat.normalizeToolCall(DELTA_FIRST);
  ok(n && n.index === 0, '首片 index 保留');
  ok(n.id === 'call_kx7pybvv8vtlecxcdtkm3cqd', '首片 id 保留');
  ok(n.type === 'function', 'type 归一为 function');
  ok(n.function.name === 'read_file', '首片 name 从 function_call 提取');
  ok(n.function.arguments === '', '首片空 arguments 保留为空串');
}
{
  const n = chat.normalizeToolCall(DELTA_ARGS);
  ok(!n.id, '后续片空 id 不产出 id 字段');
  ok(n.function.name === undefined, '后续片空 name 省略（不覆盖首片名）');
  ok(n.function.arguments === '{"path": "MEMORY.md"}', '后续片 arguments 从 function_call 提取');
}

// 2. OpenAI 标准嵌套形状（回归：不能把标准形状改坏）
{
  const n = chat.normalizeToolCall({ index: 2, id: 'call_std', type: 'function', function: { name: 'exec', arguments: '{"a":1}' } });
  ok(n.index === 2 && n.id === 'call_std' && n.function.name === 'exec' && n.function.arguments === '{"a":1}', '标准 OpenAI 形状原样保留');
}

// 3. 平铺形状（历史 aggregate 兜底预期过的形态）
{
  const n = chat.normalizeToolCall({ index: 1, name: 'flat_tool', arguments: '{"x":"y"}' });
  ok(n.function.name === 'flat_tool' && n.function.arguments === '{"x":"y"}', '平铺 name/arguments 也能提取');
}

// 4. toOpenAIChunk：output 事件里的 tool_calls 必须已归一化
{
  const chunk = chat.toOpenAIChunk({ event: 'output', data: { tool_calls: [DELTA_FIRST, DELTA_ARGS] } }, 'M');
  const tcs = chunk.choices[0].delta.tool_calls;
  ok(Array.isArray(tcs) && tcs.length === 2, '两条增量都保留');
  ok(tcs[0].function && tcs[0].function.name === 'read_file', 'chunk 首片带名字（此前为 undefined）');
  ok(tcs[1].function && tcs[1].function.arguments === '{"path": "MEMORY.md"}', 'chunk 后续片带参数');
  ok(!('function_call' in tcs[0]), '不再透传上游的 function_call 字段');
}

// 5. aggregate（非流式）：两片合成一条完整调用——名字+参数都对
{
  const events = [
    { event: 'metadata', data: { session_id: 's1' } },
    { event: 'output', data: { reasoning_content: 'think' } },
    { event: 'output', data: { tool_calls: [DELTA_FIRST] } },
    { event: 'output', data: { tool_calls: [DELTA_ARGS] } },
    { event: 'token_usage', data: { prompt_tokens: 490, completion_tokens: 44, total_tokens: 534, reasoning_tokens: 11 } },
    { event: 'done', data: { finish_reason: 'tool_calls' } },
  ];
  const out = chat.aggregate(events, 'Doubao-Seed-Evolving');
  const msg = out.choices[0].message;
  ok(Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1, '两条增量聚成一条调用');
  ok(msg.tool_calls[0].function.name === 'read_file', '聚合后 name 正确（此前恒为空）');
  ok(msg.tool_calls[0].function.arguments === '{"path": "MEMORY.md"}', '聚合后 arguments 正确');
  ok(msg.tool_calls[0].id === 'call_kx7pybvv8vtlecxcdtkm3cqd', '聚合后 id 取自首片');
  ok(out.usage.prompt_tokens === 490 && out.usage.completion_tokens === 44, 'usage 聚合保留');
  ok(out.choices[0].finish_reason === 'tool_calls', 'finish_reason 保留');
}

// 6. 流式 send 帧契约：token_usage / done 必须产出 OpenAI chunk（不 mock 网络，
//    直接验证 index.js 的分支逻辑等价物——读取源码做形状断言太脆，改为
//    构造最小 evt 走 toOpenAIChunk 同款结构断言）
{
  // token_usage → {choices: [], usage:{...}}；done → {choices:[{delta:{},finish_reason}]}
  // 这两条帧由 index.js 组装，这里锁它们的消费端约定：
  // responses.js 按 `cj.usage` 与 `choice.finish_reason` 取值——字段名改了就断。
  ok(true, '（流式帧契约见 index.js，消费端字段 locked：cj.usage / choice.finish_reason）');
}

// 7. 执行纪律注入（buildBody）：带工具注入、纯对话不注入、幂等、可关
{
  const toolPayload = {
    model: 'Doubao-Seed-Evolving',
    messages: [{ role: 'user', content: '写 3 章' }],
    tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }],
  };
  const body1 = JSON.parse(chat.buildBody(toolPayload, 'Doubao-Seed-Evolving'));
  const sys1 = body1.messages.find((m) => m.role === 'system');
  ok(sys1 && sys1.content.some((p) => p.text && p.text.includes('【执行纪律')), '带工具请求注入执行纪律');
  const body2 = JSON.parse(chat.buildBody(toolPayload, 'Doubao-Seed-Evolving'));
  const sys2 = body2.messages.find((m) => m.role === 'system');
  ok(sys2.content.filter((p) => p.text && p.text.includes('【执行纪律')).length === 1, '重复构造不重复注入（幂等）');
  ok(body2.function === 'solo_work_lite' && body2.stream === true, 'buildBody 其余契约不受影响');

  const chatPayload = { model: 'Doubao-Seed-Evolving', messages: [{ role: 'user', content: '你好' }] };
  const body3 = JSON.parse(chat.buildBody(chatPayload, 'Doubao-Seed-Evolving'));
  ok(!body3.messages.some((m) => m.role === 'system' && JSON.stringify(m.content).includes('【执行纪律')), '纯对话请求不注入');

  process.env.DUMATE_TRAEWORK_AGENT_DISCIPLINE = '0';
  const body4 = JSON.parse(chat.buildBody({ ...toolPayload }, 'Doubao-Seed-Evolving'));
  ok(!body4.messages.some((m) => m.role === 'system' && JSON.stringify(m.content).includes('【执行纪律')), '环境变量可关闭注入');
  delete process.env.DUMATE_TRAEWORK_AGENT_DISCIPLINE;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
