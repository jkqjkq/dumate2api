// test/verify-truncated-toolcall.js - 「工具参数被截断」的离线验证
//
// 不依赖网关/上游：直接给 Responses 翻译器喂一段假的 OpenAI SSE，
// 断言它把「参数停在半句 JSON」判成 incomplete，并把原因写进埋点 extra。
//
// 背景（实测，2026-09-27）：千问通道跑 Codex「一次写 3 章」时，上游在
// finish_reason=length 处把工具参数停在半句（`{"cmd": "... @('第三章　第七户','',`），
// 网关原样当 completed 发给 Codex，Codex 执行语法残缺的命令失败，
// 模型随即放弃任务只留一句「下一步：写入第 3 章」——表现为「没做完就退出」。
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const { translateStreamToResponses, truncatedArguments } = require('../src/responses');

let failures = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`);
}

// ---- 1. 纯函数：什么样的参数算截断 ----
console.log('== truncatedArguments ==');
check('半截 JSON 判为截断', truncatedArguments('{"cmd": "Set-Content ... @(\'第三章\',\'') === true);
check('空串不算截断（无参工具合法）', truncatedArguments('') === false);
check('null 不算截断', truncatedArguments(null) === false);
check('完整 JSON 对象不算截断', truncatedArguments('{"cmd":"ls"}') === false);
check('完整 JSON 数组不算截断', truncatedArguments('[]') === false);
check('裸数字判为截断', truncatedArguments('123') === true);
check('纯文本判为截断', truncatedArguments('not json') === true);
console.log('');

// ---- 2. 端到端：喂一段「参数被截断」的 SSE，看收尾状态 ----
function runScenario(name, chunks) {
  return new Promise((resolve) => {
    const up = new PassThrough();
    const res = {
      headersSent: false,
      writeHead() { this.headersSent = true; },
      write() { return true; },
      end() {},
    };
    const events = [];
    const originalWrite = res.write.bind(res);
    res.write = (s) => { events.push(String(s)); return originalWrite(s); };

    let doneArgs = null;
    translateStreamToResponses(up, res, 'qwen/flash', (usage, status, extra) => {
      doneArgs = { usage, status, extra };
      resolve({ name, events, doneArgs });
    });
    for (const c of chunks) up.write(c);
    up.end();
  });
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d, finish) => sse({ choices: [{ index: 0, delta: d, finish_reason: finish || null }] });

(async () => {
  console.log('== 场景 A：工具参数停在半句 + finish_reason=length ==');
  const a = await runScenario('truncated', [
    delta({ reasoning_content: '让我写第三章' }),
    delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd": "Set-Content -LiteralPath \'out/003.txt\' -Value @(\'第三章　第七户\',' } }] }),
    delta({}, 'length'),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 900, total_tokens: 1000 } }),
    'data: [DONE]\n\n',
  ]);
  const completedA = a.events.find((e) => e.includes('response.completed'));
  check('收尾埋点状态为 200（流式路径不变）', a.doneArgs && a.doneArgs.status === 200, JSON.stringify(a.doneArgs && a.doneArgs.extra));
  check('埋点带 error=tool_arguments_truncated', !!(a.doneArgs && a.doneArgs.extra && a.doneArgs.extra.error === 'tool_arguments_truncated'), JSON.stringify(a.doneArgs && a.doneArgs.extra));
  check('response.completed 报 status=incomplete', !!completedA && completedA.includes('"status":"incomplete"'));
  check('incomplete_details 给出 max_output_tokens', !!completedA && completedA.includes('max_output_tokens'));
  console.log('');

  console.log('== 场景 B：工具参数完整 + finish_reason=tool_calls ==');
  const b = await runScenario('complete', [
    delta({ tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'exec_command', arguments: '{"cmd": "ls"}' } }] }),
    delta({}, 'tool_calls'),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }),
    'data: [DONE]\n\n',
  ]);
  const completedB = b.events.find((e) => e.includes('response.completed'));
  check('完整参数报 status=completed', !!completedB && completedB.includes('"status":"completed"'));
  check('埋点不带 error', !(b.doneArgs && b.doneArgs.extra && b.doneArgs.extra.error), JSON.stringify(b.doneArgs && b.doneArgs.extra));
  console.log('');

  console.log(failures ? `失败 ${failures} 项` : '全部通过');
  process.exit(failures ? 1 : 0);
})();
