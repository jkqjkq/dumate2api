// src/traework/index.js - TRAE Work 通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道，
// 不碰 OAuth、设备标识、SSE 聚合的细节。与 qwenwork/index.js 同构。
const c = require('./constants');
const chat = require('./chat');
const authStore = require('./auth');
const models = require('./models');

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
      authStore.patch(a.id, { lastError: `刷新失败: ${r.error}` });
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
 * 发对话请求。
 * @param {object} payload OpenAI 格式请求体
 * @param {function} [onChunk] 流式回调（收到解出来的 OpenAI 行）
 * @param {object} [opts] { reqId } 请求埋点的 id，用于把积分归因与日志精确配对
 */
async function send(payload, onChunk, opts = {}) {
  const auth = await pickAccount();
  const model = payload && payload.model ? String(payload.model).replace(/^traework\//, '') : c.DEFAULT_MODEL;
  const body = chat.buildBody(payload, model);
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

  const r = await chat.postStream(body, auth);
  if (!r.stream) {
    settle();
    throw new Error(`traework 请求失败: ${r.error || ('HTTP ' + r.status)}`);
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
    // 上游 4xx 通常没产生消耗，但仍采一次：若真扣了费，差值会落在下一条上，
    // 而「不采集」会让下一条的差值跨过这一条，两条都不准
    settle();
    const err = new Error(`traework ${r.status}: ${raw.slice(0, 200)}`);
    err.statusCode = r.status;
    throw err;
  }

  const events = [];
  let streamErr = null;
  await chat.readStream(r.stream, (evt) => {
    events.push(evt);
    // 上游报错**不能转给下游**：流式路径的 HTTP 头早已发出（恒 200），
    // 写进去客户端会当成数据帧收下，改不成 4xx 了。所以先记下来，
    // 流结束后统一抛，让上层按错误处理。
    const e = chat.eventError(evt);
    if (e && !streamErr) streamErr = e;
    // 流式：把 output 事件转成 OpenAI chunk 形状回调出去
    if (onChunk && evt.event === 'output') {
      onChunk(JSON.stringify(chat.toOpenAIChunk(evt, model)));
    } else if (onChunk && evt.event === 'token_usage') {
      // 用量帧按 OpenAI 的 include_usage 约定补发（choices 空数组 + usage）。
      // 不补的话，流式请求在客户端与埋点里 token 恒为 0，
      // 「这轮花了多少」就再也对不上账。
      const d = evt.data || {};
      onChunk(JSON.stringify({
        id: 'traework', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [],
        usage: {
          prompt_tokens: d.prompt_tokens || 0,
          completion_tokens: d.completion_tokens || 0,
          total_tokens: d.total_tokens || 0,
          completion_tokens_details: { reasoning_tokens: d.reasoning_tokens || 0 },
        },
      }));
    } else if (onChunk && evt.event === 'done' && evt.data && evt.data.finish_reason) {
      // 终止原因按 OpenAI 约定补一帧。翻译器靠它判 completed/length——
      // 不补的话 length 截断会被当成正常收尾，客户端无从察觉。
      onChunk(JSON.stringify({
        id: 'traework', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason: evt.data.finish_reason }],
      }));
    }
  });
  settle();
  if (streamErr) {
    const e = new Error(`traework ${streamErr.code}: ${streamErr.message}`);
    e.statusCode = streamErr.code >= 400 && streamErr.code < 600 ? streamErr.code : 400;
    e.upstreamCode = streamErr.code;
    throw e;
  }

  if (onChunk) return { streamed: true };
  return chat.aggregate(events, model);
}

module.exports = {
  status, send, listModels, listModelEntries, warmupModels, pickAccount,
  DEFAULT_MODEL: c.DEFAULT_MODEL,
};
