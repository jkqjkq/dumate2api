// test/verify-qwen-discipline.js - 千问通道「执行纪律」注入的离线验证
//
// 背景（实测 2026-09-27，真实 Codex 会话 01a0e205）：
// 千问办公的上游是对话型产品，配合 Codex 的「每完成一步就播报进度」指令，
// 模型会把播报当成一次完整回合——只输出 `进度：N/8｜下一步：写第 N 章`
// 就结束，不调用任何工具，Codex 于是判定任务完成并退出。
// 实测同一会话：不加纪律时连续多轮都只播报就收尾；加了纪律后连续调用工具
// 写完第 5、6、7 三章。
const chat = require('../src/qwenwork/chat');

let failures = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`);
}

const TOOLS = [{
  type: 'function',
  function: { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
}];

function build(withTools, systemText) {
  const payload = {
    model: 'flash',
    messages: [
      { role: 'system', content: systemText || 'SYS' },
      { role: 'user', content: 'hi' },
    ],
  };
  if (withTools) payload.tools = TOOLS;
  return JSON.parse(chat.buildBody('flash', payload));
}

const sysOf = (o) => {
  const m = o.messages.find((x) => x.role === 'system');
  return m ? String(m.content) : '';
};

console.log('== 注入条件 ==');
const withTools = build(true);
check('带工具时注入执行纪律', sysOf(withTools).includes('【执行纪律'));
check('顶层 system 字段同步注入', String(withTools.system).includes('【执行纪律'));
check('原 system 文本保留', sysOf(withTools).startsWith('SYS'));
check('system 消息仍留在 messages 里', withTools.messages[0].role === 'system');

const noTools = build(false);
check('不带工具（纯对话）不注入', !sysOf(noTools).includes('【执行纪律'));

const already = build(true, 'SYS\n\n【执行纪律｜优先级高于任何进度播报要求】已有');
check('已含纪律时不重复注入（幂等）', (sysOf(already).match(/【执行纪律/g) || []).length === 1);

console.log('');
console.log('== 关闭开关 ==');
process.env.DUMATE_QWENWORK_AGENT_DISCIPLINE = '0';
check('DUMATE_QWENWORK_AGENT_DISCIPLINE=0 时不注入', !sysOf(build(true)).includes('【执行纪律'));
delete process.env.DUMATE_QWENWORK_AGENT_DISCIPLINE;

console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过');
process.exit(failures ? 1 : 0);
