// src/fallback-web.js - 搭子通道的网页凭证回落
//
// 背景：搭子有两条凭证链路，能力互补但各自有硬伤：
//   桌面凭证（auth.json → dumate-main-server.exe 8980）
//     优点：链路短、长期登录态、支持 responses / count_tokens / 三通道分流
//     硬伤：**同一时刻只有一份登录态，且过期后必须打开客户端重登一次**
//   网页凭证（data/web-accounts.json → 直连 dumate-svc.baidu.com）
//     优点：可多账号、token 自动续（约 1 小时一换）
//     硬伤：9084 那条链路没有 responses（Codex 用不了）、没有三通道分流
//
// 所以不整体切换（那会丢掉 Codex 支持），只做**回落**：正常走桌面凭证，
// 只有在它不可用时才把请求交给网页池。这样既保住桌面链路的能力，
// 又解决「客户端登录态过期就得开客户端」这个唯一痛点。
//
// 实现方式：把网页池包装成一个**伪上游响应**（EventEmitter + statusCode +
// headers），交给现有四个协议处理器原样复用。不重写翻译层——那三套 SSE
// 状态机（Anthropic 的 block 顺序、Responses 的 item 顺序、Google 的分片）
// 是踩了十几个坑才稳定的，重写一遍等于把那些坑再踩一次。
//
// 上游协议一致是这里成立的前提：网页池打的是同一个
// `dumate-svc.baidu.com/gateway/apis/v1/chat/completions`，返回 OpenAI SSE，
// 与 8980 后端吐的东西同构。
//
// ---------------------------------------------------------------------------
// 状态码时序（这是本模块最容易写错的地方）
//
// 四个处理器拿到「上游响应」后会**立刻** `res.writeHead(upstreamRes.statusCode)`。
// 也就是说 statusCode 必须在把 emitter 交出去之前就定下来。而网页池的状态码
// 要等云端响应头到达才知道——两者之间有几百毫秒。
//
// 所以用「缓冲 → 等状态 → 释放」：
//   1. 调用方 await ready（状态码定下来，成功 200 或失败 4xx/5xx）
//   2. 调用方把 emitter 交给处理器（此时 writeHead 拿到的是正确状态码）
//   3. 调用方 flush()，把缓冲的 chunk 放出去，之后转为直接 emit
//
// 不这样做的话，失败时头已经按 200 发出去了，客户端会收到一个空的 200——
// 本项目在别处踩过同样的坑（见 server.js 里 writeSSEHead 的注释）。
const { EventEmitter } = require('events');
const pool = require('./web-pool');

// 回落开关。默认开启——它存在的理由（桌面凭证过期）是常态而非例外。
// 设 0 可关掉，便于排查「是不是回落导致的怪现象」。
function enabled() {
  return process.env.DUMATE_WEB_FALLBACK !== '0';
}

/** 网页池里有没有可用账号。没有就谈不上回落 */
function available() {
  if (!enabled()) return false;
  try {
    return pool.snapshot().some((a) => a.enabled && !a.cooling);
  } catch (e) {
    return false;
  }
}

/**
 * 把一次网页池调用包装成伪上游响应。
 *
 * @param {object} body 已构造好的 OpenAI 请求体
 * @param {object} opts { onAccount } 供埋点回填「实际用了哪个账号」
 * @returns {{emitter, done, ready, flush}}
 *   emitter 伪上游响应；done 最终结果；ready 等状态码；flush 释放缓冲。
 */
function callWebPool(body, opts = {}) {
  const emitter = new EventEmitter();
  emitter.statusCode = 200;
  emitter.headers = { 'content-type': body.stream ? 'text/event-stream' : 'application/json' };

  let settled = false;
  let flushing = false;
  let ended = false;
  const buffered = [];
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  const settle = (code) => {
    if (settled) return;
    settled = true;
    emitter.statusCode = code;
    resolveReady();
  };
  const push = (chunk) => {
    if (flushing) emitter.emit('data', chunk);
    else buffered.push(chunk);
  };
  const end = () => {
    ended = true;
    if (flushing) emitter.emit('end');
  };
  const flush = () => {
    if (flushing) return;
    flushing = true;
    for (const c of buffered) emitter.emit('data', c);
    buffered.length = 0;
    if (ended) emitter.emit('end');
  };

  const onChunk = (chunk) => { settle(200); push(chunk); };

  const done = new Promise((resolve) => {
    const finish = (r) => resolve(r);

    const run = body.stream
      ? pool.callStreamWithFailover('/chat/completions', 'POST', body, onChunk, {
        timeout: 600000,
        onStatus: (code) => { if (code >= 200 && code < 300) settle(200); },
      })
      : pool.callWithFailover('/chat/completions', 'POST', body, { timeout: 600000 });

    Promise.resolve(run).then((r) => {
      if (r && r.account) {
        // 挂到 emitter 上：调用方在回调里读它写埋点。
        // 多账号轮询下「实际用了哪个」只有池子知道，在埋点处猜必然是错的。
        emitter._account = r.account.name;
        if (typeof opts.onAccount === 'function') {
          try { opts.onAccount(r.account.name); } catch (e) { /* 归因失败不影响转发 */ }
        }
      }
      if (!r) {
        settle(502);
        push(JSON.stringify({ error: { message: '网页池无响应', type: 'api_error' } }));
        return end(), finish({ ok: false, status: 502, error: '网页池无响应' });
      }

      if (!r.ok) {
        // 失败：给出明确状态码，别让下游以为成功
        settle(r.status || 502);
        emitter.headers = { 'content-type': 'application/json' };
        push(JSON.stringify({
          error: { message: r.error || 'web fallback failed', type: 'api_error' },
        }));
        end();
        return finish({ ok: false, status: emitter.statusCode, error: r.error, json: r.json });
      }

      if (!body.stream) {
        // 非流式：一次性把完整 JSON 交给下游（它的分支就是累加后解析）
        settle(200);
        push(r.raw || JSON.stringify(r.json || {}));
        end();
        return finish({ ok: true, status: 200, json: r.json, account: r.account });
      }

      // 流式：chunk 已在 onChunk 里推过，这里只收尾
      settle(200);
      end();
      return finish({ ok: true, status: 200, account: r.account });
    }).catch((e) => {
      settle(502);
      emitter.headers = { 'content-type': 'application/json' };
      push(JSON.stringify({ error: { message: e.message, type: 'api_error' } }));
      end();
      finish({ ok: false, status: 502, error: e.message });
    });
  });

  return { emitter, done, ready, flush };
}

module.exports = { enabled, available, callWebPool };
