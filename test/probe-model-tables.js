// test/probe-model-tables.js - 看四条通道的模型表实际能拿到哪些元数据
//
// 「一键配置到 cc-switch」要填的上下文窗口与输出上限，不能拍脑袋：
// 同一份 provider 配置对该通道下**所有**可选模型生效，所以只能取最小值，
// 否则切到窗口小的那个模型就会 400（TRAE 的 DeepSeek 系 200K vs Doubao 256K
// 就是这么踩出来的）。
//
// 本探针把 model-info.js 的四个 rowsFor 打出来，看清每个字段的真实来源：
//   upstream = 上游模型表下发；measured = 本项目实测；config = 本地配置
//
// 用法：node test/probe-model-tables.js
const mi = require('../src/model-info');

const CH = ['dumate', 'qwenwork', 'traework', 'qoder'];

(async () => {
  for (const ch of CH) {
    let r;
    try {
      r = await mi.rowsFor(ch);
    } catch (e) {
      console.log(`\n===== ${ch} =====  失败: ${e.message}`);
      continue;
    }
    const rows = r.rows || [];
    console.log(`\n===== ${ch} =====  模型 ${rows.length} 个${r.error ? '  错误: ' + r.error : ''}`);

    const ctxs = [];
    const outs = [];
    for (const m of rows.slice(0, 6)) {
      const ctx = m.contextWindow;
      const out = m.maxTokens;
      if (typeof ctx === 'number') ctxs.push(ctx);
      if (typeof out === 'number') outs.push(out);
      console.log(`  ${String(m.id).padEnd(30)} ctx=${String(ctx).padEnd(9)}(${m.contextSource || '-'})  maxOut=${String(out).padEnd(8)}(${m.maxTokensSource || '-'})  rate=${m.rate ?? '-'}`);
    }
    if (rows.length > 6) console.log(`  … 其余 ${rows.length - 6} 个省略`);

    // 汇总：配置该通道时应声明的值 = 所有模型的最小值
    for (const m of rows) {
      if (typeof m.contextWindow === 'number') ctxs.push(m.contextWindow);
      if (typeof m.maxTokens === 'number') outs.push(m.maxTokens);
    }
    const minCtx = ctxs.length ? Math.min(...ctxs) : null;
    const minOut = outs.length ? Math.min(...outs) : null;
    console.log(`  → 声明上下文 = ${minCtx ?? '(无数据)'}  压缩线(85%) = ${minCtx ? Math.round(minCtx * 0.85) : '(无)'}  输出上限 = ${minOut ?? '(无数据)'}`);
  }
})();
