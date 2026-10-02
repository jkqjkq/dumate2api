// src/model-info.js - 三条通道的模型信息（统一形状，每个字段带来源）
//
// 三个通道能拿到的元信息**完全不同**，所以不能用一个模板套：
//
//   搭子（dumate）  上游没有模型列表接口（/models 实测 404），真实模型只有
//                   model-text / model-artifact-validate / glm-5。上下文与
//                   输出预算来自本项目实测与配置，不是上游给的。
//   千问（qwenwork）模型表由 /api/v2/model/list 下发，但**该接口会 403**，
//                   此时回落静态表（pro / flash）。上下文上限来自实测。
//   TRAE（traework）唯一有完整元信息的：上游下发 42 个模型，带消耗倍率、
//                   上下文窗口、输出上限、会员折扣。
//
// **每个字段都带 source**，因为「这个数字哪来的」决定了它能不能信：
//   'upstream' 上游接口下发 · 'measured' 本项目实测 · 'config' 本地配置
// 拿不到的字段一律 null，界面显示「—」。**不估算、不拿同类模型的值顶上**
// ——那会让用户以为上下文真的有 128K，直到请求失败才发现。
const modelmap = require('./modelmap');
const channels = require('./channels');

/** 字段来源标记（前端据此显示小徽标） */
const SRC = {
  upstream: '上游',
  measured: '实测',
  config: '配置',
};

// 搭子：上游没有模型列表接口（/models、/model/list 实测 404），
// 真实可用的名字来自探测（ARCHITECTURE.md 的实测结论 + model-map 的 upstream_models）
const DUMATE_NOTE = '上游无模型列表接口，名字来自探测；真实可用的只有 model-text / model-artifact-validate / glm-5。';
// 上下文：DuMate 配置声明 192K，但 32K 级实测通过、128K 级 10 分钟未返回。
// 给区间而不是单值——单值会让人以为 192K 可用。
const DUMATE_CONTEXT = { min: 32768, max: 192000, note: '配置声明 192K；32K 级实测通过，128K 级 10 分钟未返回' };

// 千问：上下文上限实测 ~1,024,000（1250K 汉字 = 1,022,745 通过；1262K 起 502）
const QW_CONTEXT = { min: null, max: 1024000, note: '实测 ~1,024,000（1250K 汉字通过；1262K 起 502）' };

/** 千问模型的中文名与上下文。接口 403 时只有静态表，所以这些是本地实测值 */
const QW_META = {
  pro: { name: '高级', context: QW_CONTEXT },
  flash: { name: '标准', context: QW_CONTEXT },
};

/**
 * 搭子的模型行。
 * 别名与暴露列表来自 model-map.json（可经管理端编辑），
 * 上下文与预算来自实测/配置，**没有倍率概念**——搭子的计费在上游账单里，
 * 本地拿不到单价，所以 rate 一律 null。
 */
function dumateRows() {
  const cfg = modelmap.load();
  const upstream = new Set(cfg.upstream_models);
  const budget = require('./budget');
  const rows = [];
  // 暴露列表里的每个名字都列出来（含别名），因为它们都是客户端可传的
  for (const id of cfg.exposed) {
    const target = cfg.aliases[id] || id;
    rows.push({
      id,
      name: id,
      prefixed: id,
      channel: 'dumate',
      native: upstream.has(id),
      target,
      rate: null,
      rateSource: null,
      contextWindow: DUMATE_CONTEXT.max,
      contextWindowMin: DUMATE_CONTEXT.min,
      contextSource: 'measured',
      contextNote: DUMATE_CONTEXT.note,
      // 输出预算：网关钳制后的下限（客户端传更小的值会被抬到这里）
      maxTokens: budget.resolveMaxTokens(0),
      maxTokensSource: 'config',
      capability: 'chat_model',
      multimodal: false,
      note: DUMATE_NOTE,
    });
  }
  return rows;
}

/** 千问的行。倍率本地拿不到（计费在 qwenwork.cn 的积分池里），如实 null */
function qwenworkRows() {
  const constants = require('./qwenwork/constants');
  let keys = constants.FALLBACK_MODELS.slice();
  let source = 'config';
  // listModels 内部会先试接口、失败回落静态表，这里只看结果
  const cached = qwenworkCachedKeys();
  if (cached && cached.length) { keys = cached; source = 'upstream'; }
  const budget = require('./budget');
  return keys.map((k) => {
    const meta = QW_META[k] || {};
    return {
      id: k,
      name: meta.name || k,
      prefixed: `qwen/${k}`,
      channel: 'qwenwork',
      native: true,
      target: k,
      rate: null,
      rateSource: null,
      contextWindow: meta.context ? meta.context.max : null,
      contextWindowMin: meta.context ? meta.context.min : null,
      contextSource: meta.context ? 'measured' : null,
      contextNote: meta.context ? meta.context.note : '',
      maxTokens: budget.resolveQwenMaxTokens(0),
      maxTokensSource: 'config',
      capability: 'chat_model',
      multimodal: false,
      note: source === 'upstream' ? '' : '模型列表接口 403，当前为静态表（pro / flash）',
    };
  });
}

// 千问模型表的缓存快照由 index.js 在成功拉取后写入
let qwenKeysCache = null;
function setQwenKeys(keys) {
  qwenKeysCache = Array.isArray(keys) && keys.length ? keys.slice() : null;
}
function qwenworkCachedKeys() {
  return qwenKeysCache;
}

// Qoder 模型表的缓存快照（上游下发，带倍率）。由 qoder/index.js 写入。
// **注意跨进程问题**：网关进程调 listModels 会写这里，但 /models/info 跑在
// 管理端进程，两者模块状态独立——所以 qoderRows 不能只依赖这个快照，
// 必须自己拉一次（见下面的实现）。这与 traeworkRows 直接 fetchModels 同理。
let qoderModelsCache = null;
function setQoderModels(list) {
  qoderModelsCache = Array.isArray(list) && list.length ? list.slice() : null;
}
function qoderCachedModels() {
  return qoderModelsCache;
}

/**
 * Qoder 的行：上游下发，带倍率（price_factor）。
 *
 * **自己拉而不是读快照**：快照由网关进程写入，管理端进程看不到。
 * 取不到时回落静态表（rate 给 null，如实标「无此数据」，不估算）。
 */
async function qoderRows() {
  const constants = require('./qoder/constants');
  const budget = require('./budget');
  let list = qoderCachedModels();
  let fromUpstream = !!list;
  if (!list) {
    // 直接问上游（进程内），与 traeworkRows 同一策略
    try {
      const authStore = require('./qoder/auth');
      const session = require('./qoder/session');
      const acc = authStore.preferred();
      if (acc) {
        const r = await session.fetchModels(acc);
        if (r.ok && r.models.length) { list = r.models; fromUpstream = true; }
      }
    } catch (e) { /* 拿不到就回落静态表 */ }
  }
  // 两种形状都要接受：session.fetchModels 给的是归一化形状（rate/contextWindow），
  // 而 setQoderModels 可能收到原始上游形状（price_factor/max_input_tokens）。
  // 只认一种会让其中一条路径静默给出 null。
  const items = fromUpstream && list
    ? list.map((m) => ({
      key: m.key,
      name: m.name || m.display_name || m.key,
      rate: typeof m.rate === 'number' ? m.rate : (typeof m.price_factor === 'number' ? m.price_factor : null),
      ctx: typeof m.contextWindow === 'number' ? m.contextWindow : (typeof m.max_input_tokens === 'number' ? m.max_input_tokens : null),
    }))
    : constants.FALLBACK_MODELS.map((k) => ({ key: k, name: k, rate: null, ctx: null }));
  return items.map((m) => ({
    id: m.key,
    name: m.name || m.key,
    prefixed: `qoder/${m.key}`,
    channel: 'qoder',
    native: true,
    target: m.key,
    // 倍率是相对值（price_factor），不是积分绝对值——与 TRAE 同理
    rate: typeof m.rate === 'number' ? m.rate : null,
    rateSource: typeof m.rate === 'number' ? 'upstream' : null,
    contextWindow: typeof m.ctx === 'number' ? m.ctx : null,
    contextWindowMin: null,
    contextSource: typeof m.ctx === 'number' ? 'upstream' : null,
    contextNote: '',
    maxTokens: budget.resolveQoderMaxTokens(0),
    maxTokensSource: 'config',
    capability: 'chat_model',
    multimodal: false,
    // 便宜档标记：0.1 倍率的适合调试（省额度）
    note: (typeof m.rate === 'number' && m.rate <= 0.1) ? '低倍率，适合开发调试' : '',
  }));
}

/** TRAE 的行：唯一有完整上游元信息的通道 */
async function traeworkRows({ visibleOnly = false, force = false } = {}) {
  const models = require('./traework/models');
  const r = await models.fetchModels({ force });
  let list = r.models;
  if (visibleOnly) list = list.filter((m) => m.visible);
  return {
    ok: r.ok,
    error: r.error,
    rows: list.map((m) => ({
      id: m.id,
      name: m.name,
      prefixed: m.prefixed,
      channel: 'traework',
      native: true,
      target: m.id,
      rate: m.rate,
      rateSource: m.rate != null ? 'upstream' : null,
      rateOriginal: m.rateOriginal,
      rateDiscounted: m.rateDiscounted,
      memberDiscount: m.memberDiscount,
      discountMatched: m.discountMatched,
      contextWindow: m.contextWindow,
      contextWindowMin: null,
      contextSource: m.contextWindow != null ? 'upstream' : null,
      contextNote: '',
      maxTokens: m.maxTokens,
      maxTokensSource: m.maxTokens != null ? 'upstream' : null,
      capability: m.capability,
      multimodal: m.multimodal,
      visible: m.visible,
      usage: m.usage,
      isDefault: m.isDefault,
      isNew: m.isNew,
      isBeta: m.isBeta,
    })),
  };
}

/** 全通道一览：把三条通道拼成一张表，每行带 channel 标记 */
async function allRows({ force = false } = {}) {
  const tw = await traeworkRows({ force });
  return {
    rows: [...dumateRows(), ...qwenworkRows(), ...tw.rows, ...(await qoderRows())],
    errors: { traework: tw.error || '' },
  };
}

/** 某条通道的行 */
async function rowsFor(channel, opts = {}) {
  if (channel === 'dumate') return { rows: dumateRows(), error: '' };
  if (channel === 'qwenwork') return { rows: qwenworkRows(), error: '' };
  if (channel === 'qoder') return { rows: await qoderRows(), error: '' };
  if (channel === 'traework') {
    const r = await traeworkRows(opts);
    return { rows: r.rows, error: r.error };
  }
  return { rows: [], error: `未知通道 ${channel}` };
}

module.exports = {
  SRC, allRows, rowsFor, dumateRows, qwenworkRows, traeworkRows, qoderRows,
  setQwenKeys, setQoderModels, DUMATE_NOTE, DUMATE_CONTEXT, QW_CONTEXT, CHANNELS: channels.CHANNELS,
};
