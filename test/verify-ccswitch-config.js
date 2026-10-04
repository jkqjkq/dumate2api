// test/verify-ccswitch-config.js - 验证「一键生成 cc-switch 配置」的推导逻辑
//
// 分两层：
//   1. 纯函数断言（注入假模型表）——不依赖网络，验证推导规则本身
//   2. 真实四通道 smoke——验证能真拿到数据并算出结果
//
// 最关键的一条不变量：**上下文不能取「全部模型的最小值」**。
// TRAE 上游下发 42 个模型，最小的只有 53192；按它声明会把 Doubao 的 256K
// 浪费掉 80%。本脚本用一份「含小窗口冷门模型」的假表把这个取舍钉死。
//
// 用法：node test/verify-ccswitch-config.js
const assert = require('assert');
const cc = require('../src/admin/routes/ccswitch');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

// ---- 1. 纯函数 ----
console.log('推导规则（注入假模型表）');

const fakeRows = [
  { id: 'big-a', prefixed: 'x/big-a', name: 'Big-A', rate: 0.08, contextWindow: 256000, contextSource: 'upstream', maxTokens: 32000, maxTokensSource: 'upstream' },
  { id: 'big-b', prefixed: 'x/big-b', name: 'Big-B', rate: 0.1, contextWindow: 200000, contextSource: 'upstream', maxTokens: 32000, maxTokensSource: 'upstream' },
  { id: 'mid-c', prefixed: 'x/mid-c', name: 'Mid-C', rate: 0.2, contextWindow: 180000, contextSource: 'upstream', maxTokens: 32768, maxTokensSource: 'upstream' },
  { id: 'mid-d', prefixed: 'x/mid-d', name: 'Mid-D', rate: 0.5, contextWindow: 180000, contextSource: 'upstream', maxTokens: 32768, maxTokensSource: 'upstream' },
  // 冷门小窗口模型：**绝不能被选进档位**，否则上下文会被拖到 53192
  { id: 'tiny-embed', prefixed: 'x/tiny-embed', name: 'Tiny', rate: 9.9, contextWindow: 53192, contextSource: 'upstream', maxTokens: 8192, maxTokensSource: 'upstream' },
];

check('档位默认取倍率最低的 4 个', () => {
  const t = cc.pickTiers(fakeRows, []);
  assert.strictEqual(t.length, 4);
  assert.deepStrictEqual(t.map((m) => m.id), ['big-a', 'big-b', 'mid-c', 'mid-d']);
});

check('冷门小窗口模型不会进入档位（否则上下文被拖到 53192）', () => {
  const t = cc.pickTiers(fakeRows, []);
  assert.ok(!t.some((m) => m.id === 'tiny-embed'), '小窗口模型被选进了档位');
});

check('上下文 = 所选模型的最小值，并报出是哪个模型决定的', () => {
  const d = cc.derive(cc.pickTiers(fakeRows, []));
  assert.strictEqual(d.context_window, 180000);
  assert.ok(['mid-c', 'mid-d'].includes(d.context_owner), `owner 异常: ${d.context_owner}`);
  assert.strictEqual(d.compact_limit, 153000, '压缩线应为 85%');
});

check('输出上限 = 所选模型的最小值', () => {
  const d = cc.derive(cc.pickTiers(fakeRows, []));
  assert.strictEqual(d.max_output, 32000);
  assert.ok(d.max_output_owner);
});

check('显式指定 models 时按指定来', () => {
  const t = cc.pickTiers(fakeRows, ['x/big-a', 'x/tiny-embed']);
  assert.deepStrictEqual(t.map((m) => m.id), ['big-a', 'tiny-embed']);
  const d = cc.derive(t);
  assert.strictEqual(d.context_window, 53192, '显式指定小窗口模型时应如实取它');
});

check('上游缺字段时不编数字', () => {
  const d = cc.derive([{ id: 'x', prefixed: 'x/x', name: 'X', rate: 1 }]);
  assert.strictEqual(d.context_window, null);
  assert.strictEqual(d.compact_limit, null);
  assert.strictEqual(d.max_output, null);
});

// ---- 2. 真实四通道 ----
console.log('\n真实通道 smoke（需要上游可达）');

(async () => {
  for (const ch of ['dumate', 'qwenwork', 'traework', 'qoder']) {
    let r;
    try {
      // 与接口口径一致：TRAE 要过滤 visible=false 的工具型模型
      // （browser_use_subagent / file_search_agent 等倍率极低，不过滤会被
      //  优先选进档位并把上下文拖到 160768）。
      // 注意接口层对 Qoder 还额外做了「多账号并集」——本脚本测的是
      // model-info 的原始表，所以 Qoder 这里只会看到 preferred 账号的模型。
      r = await require('../src/model-info').rowsFor(ch, { visibleOnly: true });
    } catch (e) {
      console.log(`  ⚠ ${ch}: 读取失败 ${e.message}`);
      continue;
    }
    const rows = (r.rows || []).filter((m) => m.id);
    if (!rows.length) { console.log(`  ⚠ ${ch}: 没有模型`); continue; }
    const tiers = cc.pickTiers(rows, []);
    const d = cc.derive(tiers);
    const allMin = Math.min(...rows.filter((m) => typeof m.contextWindow === 'number').map((m) => m.contextWindow));
    console.log(`  ${ch.padEnd(9)} 档位=${tiers.length} 声明上下文=${d.context_window}(${d.context_source || '-'}) 压缩线=${d.compact_limit} 输出=${d.max_output}(${d.max_output_source || '-'})`
      + (Number.isFinite(allMin) && allMin !== d.context_window ? `   ← 全部模型最小值是 ${allMin}，没有被采用（正确）` : ''));
  }
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
