// test/probe-traework-raw.js - 探针：TRAE 上游**本身**支不支持结构化工具调用
//
// 与 probe-anth-tools.js 的分工：那个打网关的 /v1/messages（经过 anthropic.js
// 转换层），这个直接调 src/traework 的 send（只经过 buildBody 的 SOLO 形状改写）。
//
// 如果本探针能拿到 tool_calls 而网关 Anthropic 路径拿不到，就说明
// 「上游支持工具调用，是 anthropic.js 没把 tools 传过去」——而不是能力边界。
//
// 用法：node test/probe-traework-raw.js [model] [1=不带 tools]
const tw = require('../src/traework');

const MODEL = process.argv[2] || 'Doubao-Seed-Evolving';
const NO_TOOLS = process.argv[3] === '1';

const tools = [
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: '按 glob 模式列出文件，返回匹配的路径列表。',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'glob 模式，例如 **/*.md' } },
        required: ['pattern'],
      },
    },
  },
];

const payload = {
  model: MODEL,
  stream: true,
  max_tokens: 4096,
  messages: [
    { role: 'system', content: '你是一个编码代理。要查看目录内容时必须调用 Glob 工具。' },
    { role: 'user', content: '请列出当前小说项目里的全部 markdown 文件。先调用 Glob。' },
  ],
  ...(NO_TOOLS ? {} : { tools, tool_choice: 'auto' }),
};

(async () => {
  console.log(`上游原始帧（model=${MODEL}, tools=${NO_TOOLS ? '无' : '有'}）\n`);
  const frames = [];
  try {
    await tw.send(payload, (inner) => {
      frames.push(inner);
      console.log('<<', String(inner).slice(0, 300));
    }, { reqId: 'probe-raw' });
  } catch (e) {
    console.error('失败:', e.message);
  }

  const all = frames.join('\n');
  const hasToolCalls = /"tool_calls"\s*:\s*\[/.test(all);
  console.log('\n===== 判定 =====');
  console.log(`上游给出结构化 tool_calls: ${hasToolCalls ? '有 ✓' : '没有 ✗'}`);
  console.log(`帧数: ${frames.length}`);
})();
