// src/traework/models.js - 模型表（上游下发，含消耗倍率）
//
// 早期版本只硬编码了一个 DEFAULT_MODEL——那是「实测可用」的最小集合，
// 但上游其实下发了完整模型表（get_detail_param 返回 42 个），带显示名、
// 消耗倍率、上下文窗口、会员折扣。硬编码一份等于让用户看不到自己能选什么。
//
// 端点与请求形状（实测 2026-09-25）：
//   POST {AGENT_HOST}/api/ide/v1/get_detail_param
//   body: {"function":"solo_work_lite"}   ← 必须带，空 body 只回空表
//   响应: { allow_tenant_user_add_model, config_info_list: [...], metadata }
//
// **消耗倍率在 display_contact_config 里，且它是 JSON 字符串不是对象**：
//   {"consumption_rate":{"enable":true,"data":{"rate":0.78}},
//    "discount":{"enable":true,"data":{"original_consumption_rate":0.78,
//                                     "consumption_rate":0.39,"member_discount":50,
//                                     "is_discount_matched":false}}}
// 即「原价 0.78 / 会员价 0.39 / 打 5 折，但本账号未命中」。四个都要给出去——
// 只显示一个数字会让人以为自己扣的是会员价。
const c = require('./constants');
const { soloHeaders } = require('./headers');
const authStore = require('./auth');

// 模型表基本不变（随客户端版本走），但 341KB 每次拉太重，必须缓存
const CACHE_MS = parseInt(process.env.DUMATE_TRAEWORK_MODELS_CACHE_MS || '300000', 10);
let cache = { at: 0, data: null };

/** display_contact_config 是 JSON 字符串，解析失败当空对象 */
function parseContact(raw) {
  try {
    const j = JSON.parse(raw || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

function num(v) {
  return v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
}

/** 上游条目 → 界面用的扁平结构 */
function normalize(m) {
  const dc = m.display_config || {};
  const cc = parseContact(m.display_contact_config);
  const cr = (cc.consumption_rate && cc.consumption_rate.data) || {};
  const disc = (cc.discount && cc.discount.data) || {};
  // model_detail_list 里第一条是本模型的运行参数（max_tokens / 上下文上限）
  const detail = (m.model_detail_list || [])[0] || {};
  return {
    id: m.config_name,
    // 显示名可能为空（内部模型），回落 id
    name: dc.display_name || m.config_name,
    prefixed: `traework/${m.config_name}`,
    // 消耗倍率。接口不给就留 null——界面显示 —，补 0 会被读成「免费」
    rate: num(cr.rate),
    // 会员折扣：原价 / 折后价 / 折扣力度 / 本账号是否命中
    rateOriginal: num(disc.original_consumption_rate),
    rateDiscounted: num(disc.consumption_rate),
    memberDiscount: num(disc.member_discount),
    discountMatched: !!disc.is_discount_matched,
    contextWindow: num(m.context_window_tokens && m.context_window_tokens.dev),
    maxTokens: num(detail.max_tokens),
    promptMaxTokens: num(detail.prompt_max_tokens),
    capability: dc.model_capability || '',
    multimodal: !!dc.multimodal,
    isBeta: !!dc.is_beta,
    isNew: !!dc.is_new,
    isDefault: !!m.is_default,
    // 客户端可见性：隐藏的多是内部模型（子代理、自定义占位、压缩用的 summary）
    visible: !m.is_invisible_to_user,
    // 上游声明的用途，chat_completion 之外的多半不是给对话用的
    usage: m.usage || '',
  };
}

/**
 * 拉模型表（带缓存）。
 * @returns {Promise<{ok:boolean, error:string, models:Array, fetchedAt:number}>}
 */
async function fetchModels({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const auth = authStore.findUsable()[0];
  if (!auth) return { ok: false, error: '没有可用账号（需先登录）', models: [], fetchedAt: 0 };

  const r = await c.request(c.AGENT_HOST, c.EP_MODELS, {
    method: 'POST',
    // **必须带 function**：空 body 上游只回空表（实测 config_info_list: []）
    body: { function: c.FUNCTION },
    headers: soloHeaders(auth),
    timeout: 60000,
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}`, models: [], fetchedAt: 0 };
  }
  const raw = Array.isArray(r.data.config_info_list) ? r.data.config_info_list : [];
  const models = raw.filter(Boolean).map(normalize);
  const out = { ok: true, error: '', models, fetchedAt: Date.now() };
  // 拉失败不覆盖旧缓存——上游抖动不该让界面变成空表
  if (models.length) cache = { at: Date.now(), data: out };
  return out;
}

/**
 * 可调用模型 id 列表（给网关 /v1/models 用）。
 *
 * 过滤条件是「对话模型 + 客户端可见」：上游的 usage 字段把 27 个标成
 * chat_completion，但其中 9 个是**内部模型**（computer_use_subagent、
 * browser_use_subagent、file_search_agent、explore_sub_agent_v2 这类
 * 子代理，以及种子模型的历史版本），它们 is_invisible_to_user=true。
 * 全列出来会让客户端下拉里塞满用户根本不该选的名字。
 *
 * 取不到时回落静态表里的 DEFAULT_MODEL——网关的模型列表空了会让客户端
 * 直接报「没有可用模型」，比少列几个严重。
 */
function usableIds(list) {
  return list
    .filter((m) => m.visible && (m.usage === 'chat_completion' || !m.usage))
    .map((m) => m.id);
}

async function listModelIds() {
  const r = await fetchModels();
  const ids = usableIds(r.models);
  return ids.length ? ids : [c.DEFAULT_MODEL];
}

/** 同步取缓存里的 id（未预热时给静态兜底） */
function cachedModelIds() {
  if (cache.data && cache.data.models.length) {
    const ids = usableIds(cache.data.models);
    if (ids.length) return ids;
  }
  return [c.DEFAULT_MODEL];
}

/**
 * 带元信息的模型条目（给 /v1/models 用）。
 *
 * 为什么需要：cc-switch 解析模型列表读 `name` / `contextWindow`
 * （实测其二进制里与 `owned_by` 相邻的字段是 id/name/cost/contextWindow/
 * maxContextWindow）。只给 id 的话客户端只能显示 `traework/glm-5.2`
 * 这种内部 key，看不出是哪个模型。
 */
function cachedModelEntries() {
  if (cache.data && cache.data.models.length) {
    const list = cache.data.models.filter((m) => m.visible && (m.usage === 'chat_completion' || !m.usage));
    if (list.length) {
      return list.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.contextWindow || null,
        maxContextWindow: m.contextWindow || null,
      }));
    }
  }
  return [{ id: c.DEFAULT_MODEL, name: c.DEFAULT_MODEL, contextWindow: null, maxContextWindow: null }];
}

module.exports = { fetchModels, listModelIds, cachedModelIds, cachedModelEntries, usableIds, normalize, CACHE_MS };
