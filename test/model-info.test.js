// test/model-info.test.js - model-info.js 行为测试（三通道模型表）
//
// modelmap 在 require 时固化 DUMATE_ADMIN_DATA，本文件把数据目录指到
// 一次性夹具目录再加载。**不碰 traeworkRows（会真机拉模型表）**；
// qoder/qwenwork 的行全部用 setQoderModels / setQwenKeys 快照注入，
// 保证离线且不出网。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeTmpData } = require('./helpers/tmpdata');

const tmp = makeTmpData('modelinfo');
fs.writeFileSync(tmp.file('model-map.json'), JSON.stringify({
  aliases: { 'alias-a': 'model-text', 'glm-5': 'glm-5' },
  upstream_models: ['model-text', 'model-artifact-validate', 'glm-5'],
  exposed: ['alias-a', 'glm-5', 'unknown-alias'],
  fallback: 'model-text',
}));

process.env.DUMATE_ADMIN_DATA = tmp.dir;
const modelinfo = require('../src/model-info');
const budget = require('../src/budget');

test('dumateRows：别名落点语义——别名→目标、native→自身、未知名→fallback', () => {
  const rows = modelinfo.dumateRows();
  assert.equal(rows.length, 3);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    assert.equal(r.channel, 'dumate');
    assert.equal(r.rate, null, '搭子无倍率概念');
    assert.equal(r.maxTokens, budget.resolveMaxTokens(0));
  }
  // 别名行：native=false，target 指向映射目标，note 讲清楚转发去哪
  assert.equal(byId['alias-a'].native, false);
  assert.equal(byId['alias-a'].target, 'model-text');
  assert.match(byId['alias-a'].note, /model-text/);
  // 上游原生行
  assert.equal(byId['glm-5'].native, true);
  assert.equal(byId['glm-5'].target, 'glm-5');
  assert.equal(byId['glm-5'].note, modelinfo.DUMATE_NOTE);
  // 未登记别名也未登记 upstream → 走 fallback（不是映射到自身）
  assert.equal(byId['unknown-alias'].target, 'model-text');
  assert.equal(byId['unknown-alias'].native, false);
});

test('dumateRows：上下文是实测区间（不冒充上游给值）', () => {
  const r = modelinfo.dumateRows()[0];
  assert.equal(r.contextWindow, modelinfo.DUMATE_CONTEXT.max);
  assert.equal(r.contextWindowMin, modelinfo.DUMATE_CONTEXT.min);
  assert.equal(r.contextSource, 'measured');
});

test('qoderRows：归一化快照形状（session.fetchModels）映射', async () => {
  modelinfo.setQoderModels([
    {
      key: 'gfmodel', name: 'GLM Flash', rate: 0.1, rateOriginal: 1,
      contextWindow: 180000, maxInputTokens: 1000000,
      contextTiers: [180000, 1000000], reasoning: false, multimodal: true, isFree: false,
    },
  ]);
  const rows = await modelinfo.qoderRows();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.id, 'gfmodel');
  assert.equal(r.prefixed, 'qoder/GLM Flash', '调用前缀用真实模型名，不是内部代号');
  assert.equal(r.rate, 0.1);
  assert.equal(r.rateSource, 'upstream');
  assert.equal(r.rateOriginal, 1);
  assert.equal(r.contextWindow, 1000000, '上下文按最大档（ctxMax 优先于 ctx）');
  assert.match(r.contextNote, /1M/, '多档位时说明网关按最大档下发');
  assert.equal(r.capability, 'chat_model');
  assert.equal(r.multimodal, true);
  assert.match(r.note, /低倍率/);
});

test('qoderRows：原始上游形状（price_factor / context_config）同样能映射', async () => {
  modelinfo.setQoderModels([
    {
      key: 'qfmodel', display_name: 'Qwen Free',
      price_factor: 0.1, original_price_factor: 1,
      max_input_tokens: 180000,
      context_config: { t200: { token_count: 180000 }, t1m: { token_count: 1000000 } },
      is_reasoning: true, is_vl: false, is_free: true,
    },
  ]);
  const rows = await modelinfo.qoderRows();
  const r = rows[0];
  assert.equal(r.name, 'Qwen Free', 'display_name 也被认');
  assert.equal(r.rate, 0.1);
  assert.equal(r.rateOriginal, 1);
  assert.equal(r.contextWindow, 1000000, 'context_config 里取最大 token_count');
  assert.equal(r.contextSource, 'upstream');
  assert.equal(r.capability, 'reasoning_model');
  assert.equal(r.isFree, true);
  assert.match(r.contextNote, /180K \/ 1M/, '档位升序展示');
});

test('qoderRows：无快照回落静态表（如实 null，不估算）', async () => {
  modelinfo.setQoderModels(null);
  const rows = await modelinfo.qoderRows();
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.equal(r.rate, null);
    assert.equal(r.rateSource, null);
    assert.equal(r.contextWindow, null);
    assert.equal(r.isFree, false);
  }
});

test('setQoderModels：非数组/null 重置缓存', async () => {
  modelinfo.setQoderModels([{ key: 'x', rate: 2, contextWindow: 8 }]);
  modelinfo.setQoderModels('garbage');
  const rows = await modelinfo.qoderRows();
  assert.equal(rows[0].rate, null, '非法快照被丢弃，回落静态表');
});

test('qwenworkRows：默认静态表 + 注入快照后切换', () => {
  const staticRows = modelinfo.qwenworkRows();
  assert.ok(staticRows.length >= 1);
  for (const r of staticRows) {
    assert.equal(r.channel, 'qwenwork');
    assert.equal(r.rate, null);
    assert.match(r.note, /403/, '静态表标注接口不可用的背景');
  }
  modelinfo.setQwenKeys(['pro', 'flash']);
  const cached = modelinfo.qwenworkRows();
  assert.deepEqual(cached.map((r) => r.id), ['pro', 'flash']);
  assert.equal(cached[0].note, '', '上游快照来源无需标注');
  assert.equal(cached[0].contextWindow, modelinfo.QW_CONTEXT.max, 'pro/flash 在 QW_META 里，上下文用实测值');
  modelinfo.setQwenKeys(null); // 还原
});

test('rowsFor：四通道分发 + 未知通道报错', async () => {
  assert.equal((await modelinfo.rowsFor('dumate')).rows.length, 3);
  assert.equal((await modelinfo.rowsFor('qwenwork')).rows.length >= 1, true);
  const unknown = await modelinfo.rowsFor('nope');
  assert.deepEqual(unknown.rows, []);
  assert.match(unknown.error, /nope/);
});

test('SRC 标记集完整', () => {
  assert.deepEqual(Object.keys(modelinfo.SRC).sort(), ['config', 'measured', 'upstream']);
});
