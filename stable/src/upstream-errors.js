// src/upstream-errors.js - 直连通道（千问 / Qoder）共用的上游错误识别
//
// 两个产品是**同一套 COSY 协议栈**，上游的错误形状也一致。判据复制两份
// 必然漂移：2026-10-22 修 Qoder 的 `provider_error`（小写字符串 code）时，
// 千问那份还是旧的 `/^[A-Z]/` 判据——同一类「HTTP 200 + 空回答」在另一条
// 通道上继续存在。所以收敛到这里，两边都 require 这一份。
//
// 错误形状（实测）：
//   {"code":"provider_error","message":"All backends failed","type":"provider_error"}
//   {"code":"403","message":"Model is not available for this user"}
//   {"type":"provider_error","message":"..."}
//   {"error":{"code":503,"message":"..."}}
//   {statusCodeValue: 403, statusCode: "Forbidden", body: "{\"code\":\"403\",...}"}
//
// 判据要点：
//   - 数字 code >= 400
//   - 字符串 code：纯数字按数字判；其他非空串（provider_error / LoginExpired）
//     **只要带 message / type 就认**——旧实现只认首字母大写，小写的
//     `provider_error` 被当成正常数据帧转发，客户端拿到 200 + 空回答
//   - `error` 对象**先于** `type` 判：`{type:'error', error:{code:503,...}}` 里
//     真正的状态码与原因都在 error 里，先走 type 分支会把它字符串化成
//     `[object Object]`（旧实现的 bug），脏串还会被写进账号的 lastError
//   - 正常数据帧（choices / usage）没有这些字段，不会被误伤；
//     `code: 0` / `code: 'success'` 这类成功标记也明确不认
function payloadError(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // 从任意形状里取人类可读的错误串（message / msg / error 字符串或对象）
  const pick = (v) => {
    if (typeof v === 'string') return v.trim();
    if (v && typeof v === 'object') return String(v.message || v.msg || '').trim();
    return '';
  };
  const msgOf = (o) => (o && typeof o === 'object')
    ? (pick(o.message) || pick(o.msg) || pick(o.error))
    : '';

  const raw = obj.code;
  const num = raw != null && raw !== '' ? Number(raw) : null;
  if (num && num >= 400) return { code: num, message: msgOf(obj) };

  // error 对象先于字符串 code / type：这里带着最准确的状态码与原因
  if (obj.error && typeof obj.error === 'object') {
    const inner = Number(obj.error.code);
    return {
      code: Number.isFinite(inner) && inner >= 400 ? inner : 500,
      message: String(obj.error.message || obj.error.msg || obj.error.code || 'upstream error'),
    };
  }

  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n >= 400) return { code: n, message: msgOf(obj) };
    } else if (msgOf(obj) || obj.type) {
      // provider_error / LoginExpired / ...：小写也要认
      const tail = msgOf(obj);
      return { code: 500, message: tail ? `${s}: ${tail}` : s };
    }
  }

  // 没有 code 但形状是错误：{"type":"provider_error","message":"..."}
  const type = String(obj.type || '');
  if (type && (/_error$/i.test(type) || /^error$/i.test(type)) && msgOf(obj)) {
    return { code: 500, message: `${type}: ${msgOf(obj)}` };
  }
  return null;
}

/** 信封里的业务错误码（外层 HTTP 恒为 200，且可能带 data: 前缀） */
function envelopeStatus(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  // 响应体是一行行 `data:<json>`（不是裸 JSON）。早期版本直接 JSON.parse
  // 整段，前缀让解析必然失败、异常被吞成 null，于是**所有信封错误都被
  // 静默成成功**。这里逐行剥前缀。
  const candidates = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const json = t.startsWith('data:') ? t.slice(5).trim() : t;
    if (!json || json === '[DONE]') continue;
    try { candidates.push(JSON.parse(json)); } catch (e) { /* 非 JSON 行 */ }
  }
  for (const outer of candidates) {
    if (!outer || typeof outer !== 'object') continue;
    const code = outer.statusCodeValue != null ? Number(outer.statusCodeValue) : null;
    if (code && code >= 400) {
      let message = '';
      try {
        const inner = typeof outer.body === 'string' ? JSON.parse(outer.body) : outer.body;
        message = (inner && (inner.message || inner.error)) || '';
      } catch (e) { message = String(outer.body || '').slice(0, 200); }
      return { code, message };
    }
    // 非 SSE 的错误体（上游 4xx/5xx 时常见）没有信封，错误就在最外层。
    // 少了这一步，`{"code":429,...}` 这种裸错误体会被当成「没有错误」。
    const outerErr = payloadError(outer);
    if (outerErr) return outerErr;
    // 也检查内层（信封 statusCodeValue 为 200 但内层带 code 的情况）
    try {
      const inner = typeof outer.body === 'string' ? JSON.parse(outer.body) : outer.body;
      const err = payloadError(inner);
      if (err) return err;
    } catch (e) { /* 内层不是 JSON */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// code → 处置类别映射（GAP Q3,随 F1 落地）
//
// payloadError/envelopeStatus 回答「这是什么错误」,classify 回答「池子该拿它
// 怎么办」——错误类别决定账号池动作,替代 web-pool 旧的一律 markFailure。
// 类别与 src/pool.js 的冷却域一一对应（对齐 codebuddyManager 的错误策略）:
//
//   soft         429 限流 / COSY 排队限流（10605 + RESOURCE_LIMIT 等）→ 账号级
//                软冷却（有界指数退避,冷却中不叠加;上游给了 retryAfterSeconds
//                就按它,不再套基数——见 THROTTLE_TEXT 的注释）
//   hard         402/余额耗尽文案 → 硬冷却到下一次签到窗口（次日 04:00）
//   model        403+模型不可用文案 → (账号,模型) 级负缓存,切模型即可用
//   session_dead 401 → 登录态疑似失效,连续计数达阈值才禁用（防误杀:
//                网络抖动/refresh 竞态会临时性触发 401,一次就杀号会误杀,
//                对齐 codebuddy 的 12153 sessionDeadThreshold 缓冲模式）
//   breaker      5xx / 网络层失败 / 其余 403 → 熔断计数（连续失败指数退避）
//                **限流不进这里**：它带自己的重试时刻，按熔断处置会把上游
//                30 秒的条件放大成本地 30 分钟封禁（2026-10-27 修）
//   null         其余 4xx → 请求本身的问题,换账号也一样失败,不惩罚账号
//
// 保守原则:拿不准的类别宁可少惩罚。401 也可能是上游闪断,所以走「连续计数」
// 而不是直接禁用;403 只有带明确模型文案才进模型负缓存,否则按熔断兜底。
// ---------------------------------------------------------------------------

/** 余额耗尽:中文「余额/积分 不足/耗尽/用完」或英文 insufficient credit/balance/quota */
const HARD_TEXT = /(余额|积分)[^\n]{0,8}(不足|耗尽|用完)|insufficient[^\n]{0,20}(credit|balance|quota)/i;
/** 模型不可用:403 的典型文案 "Model is not available for this user" 及变体 */
const MODEL_TEXT = /model[^\n]{0,40}(not available|not found|not exist|unsupported)|模型[^\n]{0,12}(不可用|不存在|不支持)/i;

/**
 * COSY 上游的**排队/限流**信号（千问与 Qoder 共用一套协议栈）。
 *
 * 实测形状（2026-10-23~26，Qoder）：
 *   {"code":"10605","message":"{\"isQueued\":true,\"modelKey\":\"dfmodel\",
 *    \"queueCount\":0,\"queueType\":\"p3\",\"retryAfterSeconds\":30,
 *    \"serviceAvailable\":false,\"subCode\":\"RESOURCE_LIMIT\"}"}
 * 另有 subCode=CALL_COUNT_LIMIT（queueCount 上千）与「先响应后沉默」的
 * 读空闲超时（chat.js 自己造的串）。
 *
 * **这不是服务故障，是「现在别来」**——上游每次都明说 `retryAfterSeconds`
 * （实测 30 / 66 秒）。按熔断处置会把它放大成 30 分钟封禁：两次用户请求
 * 就能把整个账号池打进 30~6 小时的冷却，而真实条件 30 秒后就恢复了，
 * 客户端看到的是「Qoder 用不了」。
 */
// 引号前可能有一个转义反斜杠（上游把内层错误当字符串塞进信封，实测串里是
// `\"isQueued\":true`）——写成 `"isQueued"` 是匹配不到的，只能靠 subCode
// 兜住。两条都要能命中，否则 subCode 一改名就漏。
const THROTTLE_TEXT = /RESOURCE_LIMIT|CALL_COUNT_LIMIT|\\?"isQueued\\?"\s*:\s*true|\\?"serviceAvailable\\?"\s*:\s*false|qoder upstream (queued|read idle)/i;

/** 信封里带 modelKey = 这条限流是**某个模型**的排队，不是整条通道 */
const MODEL_QUEUE_TEXT = /\\?"modelKey\\?"/i;

/**
 * 排队冷却的**上限**。上游按自己的队列长度算 `waitTime`（实测 queueCount
 * 4697 → waitTime 7015 秒），照单全收等于把账号封近两小时，而队列随时在变。
 * 取一个「够久以防止空转、又短到能自己恢复」的窗口。
 */
const THROTTLE_MAX_MS = Math.max(
  1000,
  parseInt(process.env.DUMATE_THROTTLE_MAX_MS || '600000', 10) || 600000,
);

/**
 * 「排队挂起」类：上游接了请求却没内容，由 chat.js 的计时器主动断开
 * （`queued` = 连真实内容都没来；`read idle` = 有内容后长时间沉默）。
 *
 * 这类失败**几乎与账号健康无关**——实测同一账号挂起一次后，紧接着的
 * 5 次请求全部成功。所以不能按软冷却的 5 分钟基数处置（那会让两个账号
 * 互相把对方挡在门外，用户看到的是「全部账号排队中（300 秒后可重试）」），
 * 给一个只够防连打的短冷却，然后立刻换号/重试才是对的。
 */
const QUEUE_HANG_TEXT = /qoder upstream (queued|read idle)/i;
const QUEUE_HANG_COOLDOWN_MS = 5000;

/** 这条错误串是不是上游在说「排队/限流，稍后重试」 */
function isThrottle(message) {
  return THROTTLE_TEXT.test(String(message == null ? '' : message));
}

/**
 * 从限流错误串里取上游给的「多久后再来」（毫秒）。取不到返回 null——
 * **不编一个默认值**，由调用方决定回落口径（池的软冷却基数）。
 * 上游两个字段都可能出现：`retryAfterSeconds`（RESOURCE_LIMIT）与
 * `waitTime`（CALL_COUNT_LIMIT，同为秒）。
 */
function throttleRetryMs(message) {
  const s = String(message == null ? '' : message);
  // 上游把内层错误当**字符串**塞进信封，所以实际串里是 `\"retryAfterSeconds\":30`
  // （转义过的引号）。反斜杠可有可无，两种编码都要认，否则取不到时长。
  const re = /\\?"(?:retryAfterSeconds|waitTime)\\?"\s*:\s*(\d+(?:\.\d+)?)/gi;
  // 两个字段可能同时出现（实测 CALL_COUNT_LIMIT：retryAfterSeconds=30、
  // waitTime=66）。取**较大的**那个——waitTime 是队列里的实际预估，
  // 只按 30s 回来必然还在队里；两者取大不会把冷却做得比上游要求更短。
  let best = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const sec = Number(m[1]);
    if (Number.isFinite(sec) && sec > best) best = sec;
  }
  if (!(best > 0)) return null;
  return Math.round(best * 1000);
}

/**
 * 把一次上游错误归入池处置类别。
 *
 * @param {{status?:number, code?:unknown, message?:string, model?:string}|string|Error|null} err
 *   status 为 HTTP 状态码（0 = 网络层失败/超时）;裸字符串按网络层失败处理。
 *   model（上游模型名）原样透传：池的 model 类别要建 (账号,模型) 负缓存，
 *   缺了它 403 模型错误会退化成熔断计数（集成阶段校准——此前 classify
 *   把 model 丢掉，web 通道的模型级负缓存实际从未生效过）。
 * @returns {{kind:'soft'|'hard'|'model'|'session_dead'|'breaker'|null,
 *            status:number, message:string, model?:string, retryAfterMs?:number,
 *            scope?:'model'}}
 *   retryAfterMs 只有限流（soft）且上游明确给了时长时才带。
 *   scope==='model' 表示这条限流只针对**这个模型**（上游信封带 modelKey），
 *   池应做模型级冷却而不是账号级——否则一个模型排队会封掉整条通道。
 */
function classify(err) {
  if (err == null) return { kind: null, status: 0, message: '' };
  if (typeof err === 'string') err = { status: 0, message: err };
  else if (err instanceof Error) err = { status: 0, message: err.message };
  const status = Math.max(0, Math.floor(Number(err.status) || 0));
  // 判据用**完整串**：限流信号藏在嵌套 JSON 深处（`RESOURCE_LIMIT` 常在第
  // 150 字符之后），按 200 字截断后再匹配会时灵时不灵。
  const full = String(err.message || err.error || '');
  const message = full.slice(0, 200);
  const base = { kind: null, status, message };
  if (err.model) base.model = String(err.model).slice(0, 100);

  if (status === 429) return { ...base, kind: 'soft' };
  // 限流先于 403/5xx 判：它本质是 429 语义（「稍后再来」），不是服务坏了。
  // 顺序很关键——放后面就会被下面那条 403/5xx 的 breaker 分支吃掉。
  if (isThrottle(full)) {
    const out = { ...base, kind: 'soft' };
    const ms = throttleRetryMs(full);
    if (ms) out.retryAfterMs = Math.min(ms, THROTTLE_MAX_MS);
    // 上游没给时长（排队挂起是自己掐的）：用短冷却，别套 5 分钟基数。
    else if (QUEUE_HANG_TEXT.test(full)) out.retryAfterMs = QUEUE_HANG_COOLDOWN_MS;
    // **排队的粒度是 (账号, 模型)**（信封带 modelKey，实测同一分钟一个账号的
    // dfmodel 排 4697 位、另一个账号的 qfmodel 直接 200）。按账号级冷却会把
    // 没排队的模型一起封掉——用户配的是 dfmodel，于是连 qfmodel 都用不了，
    // 表现就是「Qoder 整条通道打不开」。带 modelKey 时降级为模型级冷却。
    if (base.model && MODEL_QUEUE_TEXT.test(full)) out.scope = 'model';
    return out;
  }
  if (status === 401) return { ...base, kind: 'session_dead' };
  if (status === 402 || HARD_TEXT.test(message)) return { ...base, kind: 'hard' };
  if (status === 403 && MODEL_TEXT.test(message)) return { ...base, kind: 'model' };
  if (status === 0 || status >= 500 || status === 403) return { ...base, kind: 'breaker' };
  // 其余 4xx（400/404/422...）:请求本身的问题,不惩罚账号
  return base;
}

module.exports = {
  payloadError, envelopeStatus, classify, isThrottle, throttleRetryMs, THROTTLE_TEXT,
};
