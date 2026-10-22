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

module.exports = { payloadError, envelopeStatus };
