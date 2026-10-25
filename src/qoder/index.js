// src/qoder/index.js - Qoder 通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道。
//
// 与千问办公的关键差异：**签名在进程内完成**（cosy.js），不需要 spawn 子进程
// 调 wasm。所以这条通道没有「签名阻塞事件循环」的问题，代码也简单得多。
//
// 每次请求都要用**该账号的**身份构造一个新的 COSY 会话（cosyKey/info 与
// uid/token 绑定），这也是为什么 buildBody 与签名放在同一次 runOnce 里。
const https = require('https');
const crypto = require('crypto');
const chat = require('./chat');
const cosy = require('./cosy');
const authStore = require('./auth');
const session = require('./session');
const constants = require('./constants');
const { normalizeError } = require('../errtext');
const ledger = require('../checkin-ledger');

/**
 * 预热**模型表**：runOnce 从同步缓存里取「该模型的最大上下文档位」（1M），
 * 缓存为空时只能回落默认档 200K。这里异步拉一次、不阻塞启动——与 TRAE 的
 * warmupModels 同一思路。
 *
 * **每个可用账号都要预热**：模型表缓存按「区域 + 账号」隔离
 * （见 session.modelsCacheKey），只预热主账号时，换号重试落到第二个账号后
 * cachedModels 为空，模型名就解析不出来。
 * 调用点原先**根本不存在**——server.js 只给千问和 TRAE 写了预热块，
 * Qoder 的预热从没被调用过，于是网关进程里的模型表缓存恒为空：
 * 客户端写显示名（qoder/GLM-5.3-Flash）时被原样当 key 发出去，
 * 上游返回 provider_error → 空回答。
 */
async function warmupModels() {
  const accounts = authStore.findUsable();
  if (!accounts.length) return { ok: false, error: '尚未添加 Qoder 账号', models: [] };
  let last = { ok: false, error: 'unknown', models: [] };
  for (const a of accounts) {
    const r = await session.fetchModels(a).catch((e) => ({ ok: false, error: e.message, models: [] }));
    if (r && r.ok && r.models && r.models.length) last = r;
    else if (!last.ok) last = r || last;
  }
  return last;
}

function status() {
  const usable = authStore.findUsable();
  return {
    ready: usable.length > 0,
    // 这条通道没有 wasm 依赖，如实标注（千问的 status 有 wasm 字段）
    needsClient: false,
    accounts: usable.length,
    error: usable.length ? '' : '尚未添加 Qoder 账号（需先登录一次）',
  };
}

function pickAccount() {
  const a = authStore.preferred();
  if (!a) throw new Error('Qoder 没有可用账号，请先添加一个');
  return a;
}

function nextAccount(exclude) {
  return authStore.findUsable().filter((a) => !exclude.has(a.id));
}

/**
 * 这个错误换账号还有救吗？
 *
 * 判据与千问同一思路：4xx（除 401/402/429/403-模型不可用）是请求本身的问题，
 * 换号也只是再失败一次。**只按数字 code 判，不匹配 message**。
 *
 * Qoder 特有：**额度耗尽时请求会挂起（不报错）**，所以这里看不到 402；
 * 真正会看到的是 `Login expired`（105，凭证失效，换号有用）与模型不可用。
 */
function retryable(code, message) {
  const n = Number(code);
  if (!Number.isFinite(n) || n === 0) return true; // 网络错误/超时：换号试一次
  if (n === 401 || n === 402 || n === 429) return true;
  if (n === 105) return true; // Login expired：凭证失效，换号有用
  if (n === 403) {
    return /not available|无权限|无权访问|login expired|expired/i.test(String(message || ''));
  }
  if (n >= 500) return true;
  return false;
}

function markFailure(account, msg) {
  try { authStore.patch(account.id, { lastError: normalizeError(msg) }); }
  catch (e) { /* 记不下不影响主流程 */ }
}

// 模型表补拉的退避窗口：失败后这段时间内不再试，避免每个请求都白等一次
// 20s 超时（模型表接口的 TIMEOUT_MS）。成功则清掉。
const MODEL_FETCH_BACKOFF_MS = 60000;
const modelFetchFailedAt = new Map();
// 同一账号的补拉共用一次 in-flight 请求：冷缓存 + 并发请求时，
// 各拉一次就是各等一次 20s。
const modelFetchInflight = new Map();

/**
 * 解析模型名；缓存里认不出来时补拉一次模型表再解析。
 *
 * 返回 `{ key, models }`。补拉失败就沿用现有缓存（可能为空）原样透传——
 * 让上游自己报错，比静默回落到别的模型好。
 *
 * 为什么不能只靠启动预热：模型表缓存按「区域 + 账号」隔离，换号重试会落到
 * 另一个账号，那份缓存可能是空的；启动时上游抖动也会让预热失败且永不重试。
 */
async function resolveModelWithFetch(auth, rawName) {
  const cached = session.cachedModels(auth) || [];
  const key = chat.resolveModelKey(rawName, cached);
  const bare = String(rawName || '').trim().replace(/^qoder\//i, '');
  const known = (list) => list.some((m) => m && (
    m.key === bare || String(m.name || '').toLowerCase() === bare.toLowerCase()
  ));
  // 已经解析出来了（别名 / 内部 key / 显示名命中），不需要再拉
  if (cached.length && (key !== bare || known(cached))) return { key, models: cached };

  const ck = `${constants.normalizeRegion(auth.region)}:${auth.uid || auth.id}`;
  if (Date.now() - (modelFetchFailedAt.get(ck) || 0) < MODEL_FETCH_BACKOFF_MS) {
    return { key, models: cached };
  }
  let inflight = modelFetchInflight.get(ck);
  if (!inflight) {
    inflight = session.fetchModels(auth).catch(() => null);
    modelFetchInflight.set(ck, inflight);
    inflight.then(() => { if (modelFetchInflight.get(ck) === inflight) modelFetchInflight.delete(ck); });
  }
  const r = await inflight;
  if (r && r.ok && r.models && r.models.length) {
    modelFetchFailedAt.delete(ck);
    return { key: chat.resolveModelKey(rawName, r.models), models: r.models };
  }
  modelFetchFailedAt.set(ck, Date.now());
  return { key, models: cached };
}

/**
 * 用指定账号跑一次请求。
 *
 * 与千问的 runOnce 结构对应，但签名是本地调用：
 *   buildBody → cosy.encode → newSession(该账号身份) → buildHeaders → post
 */
async function runOnce(account, payload, onChunk, opts, meter) {
  const auth = await session.ensureAccount(authStore, account);
  const region = constants.normalizeRegion(auth.region);
  const ep = constants.endpointsOf(region);
  // 上下文取该模型的**最大档**（模型表 context_config 的 1M/400K/200K）。
  // 缓存没预热时回落到默认档（buildBody 的 200000）。DUMATE_QODER_CONTEXT=default
  // 可整体退回默认档。
  //
  // 模型名解析要拿模型表：调用方写 `qoder/GLM-5.3-Flash`（真实名）或
  // `qoder/gfmodel`（内部 key）都要认，前者是给人看的。
  //
  // **缓存为空时必须补拉一次**（2026-10-22 修）：以前这里是纯同步读缓存，
  // 缓存为空就把显示名原样当 key 发给上游——上游认不出，回
  // `provider_error: All backends failed`，客户端收到 200 + 空回答。
  // 启动预热解决不了换号落到另一个账号的情况（缓存按账号隔离），
  // 所以热路径上留一次带退避的兜底拉取。
  const resolved = await resolveModelWithFetch(auth, payload && payload.model);
  const cachedModels = resolved.models;
  const modelKey = resolved.key;
  // 把**实际发给上游的 key** 报给埋点。不报的话 `mapped_model` 只记录调用方
  // 写的名字，显示名有没有解析成功在日志里看不出来——这次的空回答问题
  // 恰恰就是「名字没解析」却完全不可见。
  if (opts && typeof opts.onModel === 'function') {
    try { opts.onModel(modelKey); } catch (e) { /* 上报失败不影响请求 */ }
  }
  const modelMeta = cachedModels.find((m) => m.key === modelKey);
  const ctxMax = process.env.DUMATE_QODER_CONTEXT === 'default' ? null : (modelMeta && modelMeta.maxInputTokens);
  const bodyJson = chat.buildBody(modelKey, payload, { maxInputTokens: ctxMax });
  // encode 进 worker（审计 P1-5b）：几 MB 请求的编码不再独占事件循环
  const encBody = await cosy.encodeAsync(Buffer.from(bodyJson));

  // COSY 会话与账号身份绑定：uid / device_token 都进签名。
  // machineId/Token/Type 每账号一份（登录时生成并持久化）。
  const sess = cosy.newSession({
    name: auth.nickname || '',
    aid: auth.uid || '',
    uid: auth.uid || '',
    yxUid: '',
    organizationId: '',
    organizationName: '',
    userType: auth.userType || 'personal_standard',
    securityOauthToken: auth.accessToken,
    refreshToken: auth.refreshToken,
  }, auth.machineId || '', auth.machineToken || '', auth.machineType || '5');

  const headers = cosy.buildHeaders(sess, ep.ChatPathSig, encBody, 'text/event-stream', {
    'accept-encoding': 'identity',
    // 模型 key 必须同时放请求头——实测只放 body 时上游仍走 auto
    'x-model-key': modelKey,
    'x-model-source': 'system',
  });

  const startedAt = Date.now();
  // 本条请求的 credits（上游 usage 直给）。流式路径逐帧扫、取最大值——
  // 上游会在多帧里重复带 usage，最后一帧才是整轮合计。
  let peakCredits = null;
  // 参数两种形状都收：流式路径给的是整帧（看 j.usage.credits），
  // 非流式给的是聚合后的 usage 对象本身（看 u.credits）。
  const noteCredits = (o) => {
    const u = o && o.usage ? o.usage : o;
    const v = u ? Number(u.credits) : NaN;
    if (Number.isFinite(v)) peakCredits = peakCredits == null ? v : Math.max(peakCredits, v);
  };
  try {
    if (onChunk) {
      let firstErr = null;
      // `sent` 只表示**真实数据帧**已转发给下游。`[DONE]` 是哨兵、不是上游
      // 数据帧——旧实现把它也算成「已吐帧」，于是 HTTP 429 / 200+纯错误体
      // 这类「一帧数据都没有」的情况被误判成已开始输出：错误被吞、换号被挡。
      let sent = false;
      let doneSeen = false;
      // 识别到错误帧就立刻中止上游：Qoder 零额度时是**挂起**而不是报错，
      // 不主动断就要等 socket 空闲超时（600s），客户端早已超时。
      const ac = new AbortController();
      const res = await chat.postStream(ep.ChatStreamURL, encBody, headers, (inner) => {
        if (firstErr) return;
        // 哨兵延后到状态检查之后再转发，避免「先发 200 + [DONE] 再抛错」
        if (inner === '[DONE]') { doneSeen = true; return; }
        let parsed = null;
        try { parsed = JSON.parse(inner); } catch (e) { /* 非 JSON 帧照原样转发 */ }
        if (parsed) {
          const err = chat.payloadError(parsed);
          if (err) {
            firstErr = err;
            try { ac.abort(); } catch (e) { /* 已结束 */ }
            return;
          }
          noteCredits(parsed);
        }
        sent = true;
        onChunk(inner);
      }, { signal: ac.signal });
      if (firstErr) {
        const err = new Error(`qoder ${firstErr.code}: ${firstErr.message}`);
        err.statusCode = firstErr.code;
        err.sent = sent;
        throw err;
      }
      // HTTP 层错误：上游 4xx/5xx 时 body 往往不是 SSE（没有 `data:` 行），
      // 上面一帧都收不到，旧实现就当成功返回 → 客户端 200 + 空响应。
      // 这里按状态码判，并从原始 body 里取上游的 message 如实报出。
      if (res.status >= 400) {
        const es = chat.envelopeStatus(res.raw);
        const detail = (es && es.message)
          || String(res.raw || '').replace(/\s+/g, ' ').trim().slice(0, 200)
          || 'upstream error';
        const err = new Error(`qoder ${res.status}: ${detail}`);
        err.statusCode = res.status;
        err.sent = sent;
        throw err;
      }
      // 200 但不是 SSE：上游偶尔用 200 回一个纯错误体（provider_error 就是
      // 这种形状）。**判据是「一帧真实数据都没转发」**，不是「没收到
      // [DONE]」——后者恒为假（postStream 总会补一个）。
      if (!sent) {
        const es = chat.envelopeStatus(res.raw);
        if (es && es.code >= 400) {
          const err = new Error(`qoder ${es.code}: ${es.message}`);
          err.statusCode = es.code;
          err.sent = false;
          throw err;
        }
      }
      // 正常收尾：哨兵在这里补发，保证「先有内容、再有结束标记」
      if (doneSeen) onChunk('[DONE]');
      meter.settle(peakCredits);
      return res;
    }
    const res = await chat.post(ep.ChatStreamURL, encBody, headers);
    const es = chat.envelopeStatus(res.raw);
    if (es && es.code >= 400) {
      const err = new Error(`qoder ${es.code}: ${es.message}`);
      err.statusCode = es.code;
      throw err;
    }
    // 与流式路径同理：非 SSE 的 HTTP 错误体也要认，否则会聚合成一个空回答
    if (res.status >= 400) {
      const err = new Error(`qoder ${res.status}: ${String(res.raw || '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'upstream error'}`);
      err.statusCode = res.status;
      throw err;
    }
    const payloads = [];
    for (const line of String(res.raw || '').split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;
      payloads.push(...chat.unwrap(raw));
    }
    // 响应里的 model 回填**真实名**（GLM-5.3-Flash），不是内部 key：
    // 流式帧是原样转发上游的（上游恒为 "auto"），非流式这条却会把
    // gfmodel 这种代号回给客户端，两边观感不一致
    const out = chat.aggregate(payloads, (modelMeta && modelMeta.name) || modelKey);
    if (out && out.usage) noteCredits(out.usage);
    if (opts && opts.onAccount) { /* 非流式也报一次 */ }
    meter.settle(peakCredits);
    return out;
  } catch (e) {
    // 网络错误没有 statusCode，标记一下让上层知道可以换号
    if (!e.statusCode) e.statusCode = 0;
    throw e;
  }
}

/** 一次请求最多试几个账号。Qoder 签名是纯本地计算，代价低，可以放宽到 3 */
const MAX_ATTEMPTS = 3;

/**
 * 发对话请求。主账号失败且错误「换号有救」时，按可用列表顺序转移。
 */
/**
 * 积分归因的记账器。
 *
 * 与千问/TRAE 的关键差别：**Qoder 上游直给本条请求的 credits**
 * （`倍率 × tokens/1000`），所以不用做「相邻两条的差值」——每条独立可归因，
 * 首条也有值、并发也不会串账。传 null 表示没测到，如实留空不补 0。
 */
function makeMeter(account, opts) {
  return {
    settle(credits) {
      try {
        require('./credits').capture(account, credits, {
          reqId: opts.reqId || '',
          model: opts.model || '',
          ms: opts.startedAt ? Date.now() - opts.startedAt : null,
        });
      } catch (e) { /* 记账失败绝不影响已发出的响应 */ }
    },
  };
}

async function send(payload, onChunk, opts = {}) {
  const tried = new Set();
  const errors = [];
  let account = pickAccount();
  const model = payload && payload.model ? String(payload.model).replace(/^qoder\//, '') : '';
  const startedAt = Date.now();

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    tried.add(account.id);
    if (opts.onAccount) {
      const name = account.nickname || account.uid || `账号 ${account.id}`;
      try { opts.onAccount(name); } catch (e) { /* 上报失败不影响请求 */ }
    }
    // 每个账号一份：换号重试时归因要记到**实际成功的那个**账号上
    const meter = makeMeter(account, { ...opts, model, startedAt });
    try {
      const result = await runOnce(account, payload, onChunk, opts, meter);
      // 成功即清除上次的失败标记（与千问同一约定：一次瞬时失败不该永远挂着）
      if (account.lastError) {
        try { authStore.patch(account.id, { lastError: '' }); }
        catch (e) { /* 忽略 */ }
      }
      return result;
    } catch (e) {
      const code = Number(e.statusCode) || 0;
      markFailure(account, e.message);
      errors.push({ account: account.nickname || account.uid || account.id, status: code || '网络错误', error: e.message });
      if (e.sent) throw e; // 流式已吐帧，不能再换号
      if (!retryable(code, e.message)) throw e;
      const rest = nextAccount(tried);
      if (!rest.length) break;
      account = rest[0];
    }
  }

  // 带上每个账号的失败原因：只给状态码时，`(500)` / `(网络错误)` 无法区分
  // 「上游限流」「provider 挂了」「凭证失效」——排障只能去翻日志。
  const brief = (x) => {
    const m = String(x.error || '').replace(/\s+/g, ' ').trim();
    return `${x.account}(${x.status}${m ? ': ' + m.slice(0, 120) : ''})`;
  };
  const err = new Error(`Qoder 所有账号均失败：${errors.map(brief).join('；')}`);
  // 状态码 0 = 网络层失败（连接被拒/中断/首字节超时）。映射成 502 让客户端
  // 知道是上游不可用，而不是把 0 原样回出去（0 会被某些客户端当成「无错误」）。
  err.statusCode = Number(errors[errors.length - 1].status) || 502;
  throw err;
}

/**
 * 模型列表：问服务端，失败回落静态表。
 *
 * 复用 session.fetchModels（带 5 分钟缓存）——**不要在这里重写一遍拉取逻辑**，
 * 否则 model-info 与管理端会各拿一份形状不同的表。
 */
async function listModels() {
  const entries = await listModelEntries();
  return entries.map((e) => e.id.slice('qoder/'.length));
}

/**
 * 模型条目：**带真实显示名与上下文**。
 *
 * 为什么单独一个方法：`/v1/models` 要的不只是 id 列表——cc-switch 解析模型
 * 列表时读的是 `name` 字段（实测其二进制里与 `owned_by` 相邻的字段是
 * id / name / cost / contextWindow / maxContextWindow）。只给 `{id, owned_by}`
 * 的话客户端只能显示内部 key（`qoder/qfmodel`），看不出是哪个模型。
 *
 * 上下文也带上：cc-switch 会读它；声明虚高会让客户端到接近上限才压缩历史，
 * 而 Qoder 多数模型只有 180K。
 */
async function listModelEntries() {
  try {
    const account = authStore.preferred();
    if (account) {
      const r = await session.fetchModels(account);
      if (r.ok && r.models.length) {
        // 顺手告诉 model-info 上游下发的完整表（带倍率），界面据此标「上游下发」
        try { require('../model-info').setQoderModels(r.models); } catch (e) { /* 不影响返回 */ }
        return r.models.map((m) => ({
          // **id 用真实模型名**（GLM-5.3-Flash），不用内部代号（gfmodel）：
          // cc-switch 里填的是这个字段，代号根本分不清是哪个模型。
          // 两种写法都能被 resolveModelKey 解析，旧配置不受影响。
          id: `qoder/${m.name || m.key}`,
          name: m.name || m.key,
          // cc-switch 用这个值决定何时压缩历史。给**最大档**而不是默认档：
          // 上游多数模型挂着 1M 档，声明 180K 会让长会话提前压缩。
          contextWindow: m.maxInputTokens || m.contextWindow || null,
          maxContextWindow: m.maxInputTokens || m.contextWindow || null,
        }));
      }
    }
  } catch (e) { /* 拿不到就用兜底 */ }
  return constants.FALLBACK_MODELS.map((k) => ({
    id: `qoder/${k}`, name: k, contextWindow: null, maxContextWindow: null,
  }));
}

/** 账号的额度与签到（管理端用） */
function checkin(account) {
  const a = account || pickAccount();
  return checkinAndSave(a);
}

/**
 * 签到并把结果落盘到账号（`lastCheckin`）。
 *
 * 为什么要这层包装：session.checkin 是纯网络动作，不认识本地存储。而界面
 * 要回答「上次什么时候签的」——这个上游不提供（campaigns 只给当前活动的
 * claimStatus，不给领取时刻），只能本地记。与 TRAE 的 checkinAndSave 同一定位。
 *
 * 失败不打 lastError：签到失败是**瞬时**结果，写进去会让账号永久带着一个
 * 已经自愈的错误（千问/搭子的 lastError 就是这个坑）。只有确实领到了才记时间。
 */
async function checkinAndSave(account) {
  const a = account || pickAccount();
  let r;
  try {
    // 把账号传下去：签到成功时顺手写本地批次账本（过期提醒的数据源）
    r = await session.checkin(a.accessToken, a.region, { account: a });
  } catch (e) {
    return { ok: false, error: e.message, claimed: [] };
  }
  const got = (r.claimed || []).some((x) => x.ok);
  try {
    const auth = require('./auth');
    if (got) auth.patch(a.id, { lastCheckin: Date.now() });
  } catch (e) { /* 落盘失败不影响本次签到结果 */ }
  // 签到账本：某天某账号签到了（按月/按年的签到详情用它）。
  // 今天已领过（一个活动都不可领）也算「这天签过」，如实记 already。
  if (got || r.alreadyChecked) {
    ledger.append({
      channel: 'qoder', account_id: a.id, account: a.nickname || a.uid || '',
      at: Date.now(), credits: got ? r.gained : null, source: got ? 'claim' : 'already',
    });
  }
  return r;
}

function quota(account) {
  const a = account || pickAccount();
  return session.fetchQuota(a.accessToken, a.region);
}

module.exports = {
  warmupModels, status, send, listModels, listModelEntries, pickAccount, checkin, quota,
  chatCompletion: (p, opts) => send(p, undefined, opts),
  chatCompletionStream: (p, cb, opts) => send(p, cb, opts),
};
