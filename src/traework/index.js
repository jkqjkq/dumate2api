// src/traework/index.js - TRAE Work 通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道，
// 不碰 OAuth、设备标识、SSE 聚合的细节。与 qwenwork/index.js 同构。
const c = require('./constants');
const chat = require('./chat');
const authStore = require('./auth');
const models = require('./models');
const { normalizeError } = require('../errtext');

/** 通道是否可用：至少有一个启用且凭证完整的账号 */
function status() {
  const usable = authStore.findUsable();
  if (!usable.length) {
    return { ready: false, loggedIn: false, error: '没有可用账号（需先登录）', accounts: 0 };
  }
  return { ready: true, loggedIn: true, error: '', accounts: usable.length };
}

/**
 * 取一个可用账号，必要时先刷新 token。
 * 单账号阶段直接取第一个；多账号轮转后续接 web-pool 的思路。
 */
async function pickAccount() {
  const list = authStore.findUsable();
  if (!list.length) throw new Error('traework 没有可用账号');
  const a = list[0];
  if (authStore.needsRefresh(a)) {
    const r = await authStore.exchange(a);
    if (!r.ok) {
      authStore.patch(a.id, { lastError: normalizeError(`刷新失败: ${r.error}`) });
      throw new Error(`traework token 刷新失败: ${r.error}`);
    }
    authStore.patch(a.id, { ...r.patch, lastError: '' });
    return authStore.get(a.id);
  }
  return a;
}

/**
 * 模型列表。
 *
 * 优先用上游下发的完整表（src/traework/models.js，带缓存）。**同步返回**是
 * 为了不破坏调用方：server.js 的 /v1/models 与 upstream-router 都是同步调它。
 * 所以这里只读缓存，未预热时回落静态表——首次请求由 warmupModels() 预热。
 */
function listModels() {
  return models.cachedModelIds();
}

/** 带元信息的模型条目（给 /v1/models 用，客户端据此显示真实模型名） */
function listModelEntries() {
  return models.cachedModelEntries();
}

/** 预热模型表（进程启动时调一次，让 /v1/models 拿到完整列表） */
function warmupModels() {
  return models.fetchModels().catch(() => null);
}

/**
 * 跑一次上游流。
 *
 * @param {string} bodyJson 出站请求体
 * @param {object} auth 账号
 * @param {string} model 上游模型名
 * @param {function|null} emit 流式回调（收 OpenAI chunk 的 JSON 串）；为 null 即非流式
 * @param {boolean} hold 是否给正文加缓冲门（只有「带工具的流式请求」需要）
 * @returns {Promise<{events:Array, gate:object|null, streamErr:object|null, fatal:Error|null}>}
 */
async function runAttempt(bodyJson, auth, model, emit, hold) {
  const r = await chat.postStream(bodyJson, auth);
  if (!r.stream) {
    return { fatal: new Error(`traework 请求失败: ${r.error || ('HTTP ' + r.status)}`) };
  }
  if (r.status >= 400) {
    let raw = '';
    try {
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      raw = await new Promise((res) => {
        let b = '';
        r.stream.on('data', (x) => { b += dec.write(x); });
        r.stream.on('end', () => res(b + dec.end()));
      });
    } catch (e) { /* 忽略 */ }
    const err = new Error(`traework ${r.status}: ${raw.slice(0, 200)}`);
    err.statusCode = r.status;
    return { fatal: err };
  }

  const events = [];
  let streamErr = null;
  const gate = (emit && hold) ? chat.createTextGate(emit, model, true) : null;

  await chat.readStream(r.stream, (evt) => {
    events.push(evt);
    // 上游报错**不能转给下游**：流式路径的 HTTP 头早已发出（恒 200），
    // 写进去客户端会当成数据帧收下，改不成 4xx 了。所以先记下来，
    // 流结束后统一抛，让上层按错误处理。
    const e = chat.eventError(evt);
    if (e && !streamErr) streamErr = e;

    if (gate) { gate.onEvent(evt); return; }

    if (!emit) return;   // 非流式：只收集事件，聚合交给 chat.aggregate

    // 流式（未启用缓冲门）：把 output 事件转成 OpenAI chunk 形状回调出去
    if (evt.event === 'output') {
      emit(JSON.stringify(chat.toOpenAIChunk(evt, model)));
    } else if (evt.event === 'token_usage') {
      // 用量帧按 OpenAI 的 include_usage 约定补发（choices 空数组 + usage）。
      // 不补的话，流式请求在客户端与埋点里 token 恒为 0，
      // 「这轮花了多少」就再也对不上账。
      const d = evt.data || {};
      emit(JSON.stringify({
        id: 'traework', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [],
        usage: {
          prompt_tokens: d.prompt_tokens || 0,
          completion_tokens: d.completion_tokens || 0,
          total_tokens: d.total_tokens || 0,
          completion_tokens_details: { reasoning_tokens: d.reasoning_tokens || 0 },
        },
      }));
    } else if (evt.event === 'done' && evt.data && evt.data.finish_reason) {
      // 终止原因按 OpenAI 约定补一帧。翻译器靠它判 completed/length——
      // 不补的话 length 截断会被当成正常收尾，客户端无从察觉。
      emit(JSON.stringify({
        id: 'traework', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason: evt.data.finish_reason }],
      }));
    }
  });

  return { events, gate, streamErr, fatal: null };
}

/** 上游报错事件 → 可抛的错误（流式与非流式共用同一套状态码口径） */
function upstreamError(streamErr) {
  const e = new Error(`traework ${streamErr.code}: ${streamErr.message}`);
  e.statusCode = streamErr.code >= 400 && streamErr.code < 600 ? streamErr.code : 400;
  e.upstreamCode = streamErr.code;
  return e;
}

/**
 * 发对话请求。
 * @param {object} payload OpenAI 格式请求体
 * @param {function} [onChunk] 流式回调（收到解出来的 OpenAI 行）
 * @param {object} [opts] { reqId } 请求埋点的 id，用于把积分归因与日志精确配对
 */
async function send(payload, onChunk, opts = {}) {
  const auth = await pickAccount();
  const model = payload && payload.model ? String(payload.model).replace(/^traework\//, '') : c.DEFAULT_MODEL;
  const meta = {};
  const body = chat.buildBody(payload, model, meta);
  const startedAt = Date.now();

  // 上报本次实际使用的账号。**这是唯一权威的来源**：多账号轮询下
  // 「池里的第一个」与「这次选中的那个」不是一回事，埋点处猜不出来。
  const accountName = auth.nickname || auth.uid || `账号 ${auth.id}`;
  if (opts.onAccount) {
    try { opts.onAccount(accountName); } catch (e) { /* 上报失败不影响请求 */ }
  }

  // 积分归因：**必须在请求完成后**采集（请求要几秒，提前读会读到没结算的状态）。
  // 不 await —— 采集在响应发出后进行，不占请求延迟。
  // 记的是**本次实际使用的账号**（pickAccount 选出的那个），多账号下
  // 「池里的第一个」与「实际用的那个」不是一回事。
  const settle = () => {
    require('./credits')
      .capture(auth, { reqId: opts.reqId, model, startedAt })
      .catch(() => { /* 采集失败绝不影响已发出的响应 */ });
  };

  // ---- 非流式：聚合整轮，同样做「播报即收尾」修复 ----
  if (!onChunk) {
    let attempt = 0;
    let curBody = body;
    let agg = null;
    let fatal = null;
    for (;;) {
      const r = await runAttempt(curBody, auth, model, null, false);
      settle();
      if (r.fatal) { fatal = r.fatal; break; }
      if (r.streamErr) { fatal = upstreamError(r.streamErr); break; }
      agg = chat.aggregate(r.events, model);
      const msg = (agg.choices && agg.choices[0] && agg.choices[0].message) || {};
      const hasCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (hasCalls || !needsRepair(meta, msg.content) || attempt >= chat.REPAIR_MAX) break;
      attempt++;
      const nudged = chat.withRepairNudge(curBody);
      if (!nudged) break;
      curBody = nudged;
      logRepair(opts.reqId, attempt, msg.content);
    }
    if (fatal) throw fatal;
    return agg;
  }

  // ---- 流式：正文先缓冲，整轮结束再判定是否需要重试 ----
  // 详见 src/traework/chat.js 顶部「播报即收尾」的实测数据。
  let attempt = 0;
  let curBody = body;
  let res = null;
  for (;;) {
    res = await runAttempt(curBody, auth, model, onChunk, needsRepair(meta, ''));
    settle();
    if (res.fatal || res.streamErr) break;
    if (!res.gate) break;
    const g = res.gate.result();
    // 已经转为直发（正文超长 / 出现过工具调用）→ 这是正常一轮，收尾
    if (g.live || g.toolCalls > 0) break;
    if (!chat.looksUnfinished(g.text)) break;
    if (attempt >= chat.REPAIR_MAX) break;
    attempt++;
    const nudged = chat.withRepairNudge(curBody);
    if (!nudged) break;
    curBody = nudged;
    logRepair(opts.reqId, attempt, g.text);
  }

  if (res && res.gate) res.gate.finish();
  if (res && res.fatal) throw res.fatal;
  if (res && res.streamErr) throw upstreamError(res.streamErr);
  return { streamed: true };
}

/** 这一轮该不该重试：请求确实带了工具，且回复没调工具又说还有下一步 */
function needsRepair(meta, text) {
  if (chat.REPAIR_MAX <= 0) return false;
  if (!meta || !meta.toolCount) return false;
  return chat.looksUnfinished(text);
}

/** 修复触发时留一行日志——这是「模型行为」而不是「网关行为」，不记下来就无从归因。
 *  带上被丢弃的正文片段，用来区分「真·播报即收尾」与「判据误伤」（两者处置完全不同）。 */
function logRepair(reqId, attempt, text) {
  try {
    const snip = String(text || '').replace(/\s+/g, ' ').slice(0, 120);
    console.log(`[traework] 播报即收尾：第 ${attempt} 次重试（req_id=${reqId || '-'}）丢弃正文=「${snip}」`);
  } catch (e) { /* 日志失败不影响请求 */ }
}

module.exports = {
  status, send, listModels, listModelEntries, warmupModels, pickAccount,
  DEFAULT_MODEL: c.DEFAULT_MODEL,
};
