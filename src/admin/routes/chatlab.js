// src/admin/routes/chatlab.js - 聊天测试台（管理端内直接试调模型）
//
// 定位：让管理员在管理端里验证「某个模型名能不能跑通」，不用先去
// 「API 密钥」页签发密钥、再去配客户端。所以这条链路刻意不经密钥与 IP 管控，
// 只要求管理员会话——它走的是与下游 9084 同一套账号池，消耗的是真实积分。
//
// 与 9084（web-gateway）的分工：9084 是给外部客户端用的正式入口，
// 带密钥鉴权、面向协议兼容；这里是内部试调，返回给前端的是便于展示的
// 结构化数据（含每条回答的实测消耗），不做协议翻译。
const crypto = require('crypto');
const pool = require('../../web-pool');
const modelmap = require('../../modelmap');
const reqlog = require('../../reqlog');
const accounts = require('../../accounts');
const pointsCursor = require('../../points-cursor');
const web = require('../../dumate-web');
const { sendJSON, readBody } = require('../router');

// 可试调的模型名：暴露列表 + 别名。别名也要给，因为「为什么 glm-5 能用
// 但 claude-3-5-sonnet 不行」这类问题恰恰要先能选中它才试得出来。
function availableModels() {
  const cfg = modelmap.load();
  const exposed = (cfg.exposed || []).map((id) => ({ id, kind: 'upstream', mapped: cfg.aliases?.[id] || id }));
  const aliases = Object.keys(cfg.aliases || {})
    .filter((id) => !(cfg.exposed || []).includes(id))
    .map((id) => ({ id, kind: 'alias', mapped: cfg.aliases[id] }));
  return { exposed, aliases, fallback: cfg.fallback || '' };
}

// TRAE Work 的模型表（只读，来自上游常量）。试调台要能选它，否则在
// TRAE 通道下只能手打前缀——而手打错就会静默跑到搭子上去。
function traeworkModels() {
  try {
    const tw = require('../../traework');
    return tw.listModels().map((k) => ({ id: k, name: k, prefixed: `traework/${k}` }));
  } catch (e) {
    return [];
  }
}

// 每个会话的游标起点，用于算「本次对话消耗了多少」。
// 放在内存里，不落盘——这是界面上的一次试调，重启后重新开始即可。
const sessionStart = new Map();

function ssKey(req) {
  // 按管理员会话区分，避免两个管理员互相把对方的消耗算进自己的「本次消耗」
  const cookie = (req.headers.cookie || '').slice(0, 200);
  return crypto.createHash('sha1').update(cookie).digest('hex');
}

async function currentBalance() {
  const list = accounts.load().accounts.filter((a) => a.enabled);
  let sum = 0;
  let ok = false;
  for (const a of list) {
    const bal = await web.api.quotaOverview(a.cookie).catch(() => ({ ok: false }));
    if (bal.ok) { sum += bal.left; ok = true; }
  }
  return ok ? sum : null;
}

// 单个账号的余额。试调的实际消耗按「该账号请求前 - 请求后」算，
// 比全池合计更准（并发时别的账号的消耗不会混进来）。
async function balanceOf(account) {
  const r = await web.api.quotaOverview(account.cookie).catch(() => ({ ok: false }));
  return r.ok ? r.left : null;
}

// 拍一张「账号 id → 余额」的快照。请求前后各拍一次，差值即实测消耗。
// 为什么不在请求后再问一次就够：余额是累计值，没有参照点算不出单次消耗。
async function snapshotBalances() {
  const list = accounts.load().accounts.filter((a) => a.enabled);
  const out = new Map();
  await Promise.all(list.map(async (a) => {
    const left = await balanceOf(a);
    if (left !== null) out.set(a.id, left);
  }));
  return out;
}

// 实测消耗。拿不到快照返回 null——前端显示 —，不补 0
// （0 会被读成「这次没花钱」，而真相是「没测到」）。
function costOf(accountId, before, after) {
  if (!accountId || !before || !after) return null;
  const b = before.get(accountId);
  const a = after.get(accountId);
  if (typeof b !== 'number' || typeof a !== 'number') return null;
  return Math.round((b - a) * 100) / 100;
}

const routes = [
  {
    // 模型清单。前端据此渲染下拉框
    method: 'GET',
    path: '/models',
    handler: ({ res }) => sendJSON(res, 200, availableModels()),
  },
  {
    // TRAE Work 的模型清单（只读）。与搭子分开一个接口：那份映射表描述的是
    // 搭子的别名，混进来会让人以为改它能影响 TRAE 路由。
    method: 'GET',
    path: '/traework-models',
    handler: ({ res }) => sendJSON(res, 200, { models: traeworkModels() }),
  },
  {
    // 本次会话已消耗的积分（相对打开页面时的余额）
    method: 'GET',
    path: '/session-cost',
    handler: async ({ res, req }) => {
      const bal = await currentBalance();
      if (bal === null) return sendJSON(res, 200, { ok: false, consumed: null, balance: null });
      const k = ssKey(req);
      if (!sessionStart.has(k)) sessionStart.set(k, bal);
      const start = sessionStart.get(k);
      return sendJSON(res, 200, {
        ok: true,
        balance: Math.round(bal * 100) / 100,
        consumed: Math.round((start - bal) * 100) / 100,
        since: start,
      });
    },
  },
  {
    // 重置「本次消耗」的基准（点「清空对话」时调）
    method: 'POST',
    path: '/session-cost/reset',
    handler: async ({ res, req }) => {
      const bal = await currentBalance();
      sessionStart.set(ssKey(req), bal === null ? 0 : bal);
      return sendJSON(res, 200, { ok: true, since: sessionStart.get(ssKey(req)) });
    },
  },
  {
    // 试调。流式：上游 SSE 原样透传，同时解析出正文与 usage。
    //
    // 不走 callWithFailover：那条路要求 JSON 响应，会把 SSE 整体缓冲成
    // 一个字符串，首字延迟就没了。这里自己做账号轮询 + 故障转移。
    method: 'POST',
    path: '/chat',
    handler: async ({ res, req, body }) => {
      const messages = Array.isArray(body && body.messages) ? body.messages : [];
      const model = String((body && body.model) || '').trim();
      if (!messages.length) return sendJSON(res, 400, { error: 'messages 不能为空' });

      const cfg = modelmap.load();
      const mapped = modelmap.mapModel(model || cfg.fallback);
      const stream = !!(body && body.stream);
      // 预算与正式网关同一条策略：客户端给的小值会被钳到下限，
      // 否则 reasoning 吃光预算导致空回答（见 budget.js 的实测表）
      const maxTokens = require('../../budget').resolveMaxTokens(body && body.max_tokens);

      const payload = {
        model: mapped,
        messages,
        max_tokens: maxTokens,
        stream,
      };
      if (stream) payload.stream_options = { include_usage: true };

      const startedAt = Date.now();
      // 请求前拍一次余额快照，用于算这次试调的实测消耗
      const before = await snapshotBalances();

      if (!stream) {
        // 非流式直接用池里的故障转移：它会依次换账号，并把 4xx 判为
        // 「请求本身的问题」不再重试（换账号也一样失败）
        const r = await pool.callWithFailover('/chat/completions', 'POST', payload,
          { timeout: 300000 });
        const j = r.json || {};
        const choice = (j.choices || [])[0] || {};
        const msg = choice.message || {};
        const u = reqlog.pickUsage(j.usage);
        const acct = r.account || null;
        const cost = r.ok ? costOf(acct && acct.id, before, await snapshotBalances()) : null;
        reqlog.record({
          ts: Date.now(), ms: Date.now() - startedAt,
          path: '/admin/chatlab', model: model || mapped, mapped_model: mapped,
          stream: false, messages: messages.length,
          status: r.status || 0,
          input_tokens: u.input, output_tokens: u.output, total_tokens: u.total,
          ip: reqlog.clientIP(req), ua: 'admin-chatlab',
          key_id: 0, key: '', upstream: 'web',
          // 通道标搭子：chatlab 走的仍是搭子上游（模型名与计费都是搭子的），
          // 只是凭证来自网页 cookie。不标会让这条行在界面上被归成
          // 「分通道前的历史记录」——而它其实不是历史，是当下跑的
          channel: 'dumate',
          account: acct ? acct.name : '',
          error: r.ok ? '' : (r.error || 'upstream_error'),
        });
        if (!r.ok) {
          return sendJSON(res, r.status || 502, {
            error: r.error || (j.error && j.error.message) || `HTTP ${r.status}`,
          });
        }
        return sendJSON(res, 200, {
          ok: true,
          model: model || mapped,
          mapped_model: mapped,
          account: acct ? acct.name : '',
          content: msg.content || '',
          reasoning: msg.reasoning_content || '',
          usage: u,
          cost,
          ms: Date.now() - startedAt,
        });
      }

      // 流式：边收边转发。响应头一到达就先判断状态码——若不是 2xx，
      // 此时还没写出任何字节，可以换账号重试；一旦开始转发就不能换了。
      //
      // 这里只发一次上游请求：早先的写法先「探活」再正式发，会把
      // 同一次试调打两遍，真实扣两笔积分。
      const tried = new Set();
      let settled = false;      // 已写出 SSE 头，不能再换账号
      let accepted = false;     // 当前这次上游响应可用（2xx），chunk 才是正文
      let account = null;
      let text = '';
      let usage = { input: 0, output: 0, total: 0 };
      let upstreamStatus = 0;
      let upstreamErr = '';

      // send 必须定义在循环外：循环结束后还要发 done/error，
      // 定义在循环里会 ReferenceError（实测「send is not defined」，done 事件丢失）
      const send = (obj) => {
        if (!accepted) return;
        if (!settled) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          settled = true;
          sendMeta();
        }
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* 客户端断开 */ }
      };
      const sendMeta = () => {
        try {
          res.write(`data: ${JSON.stringify({
            type: 'meta', model: model || mapped, mapped_model: mapped,
            account: account ? account.name : '',
          })}\n\n`);
        } catch (e) { /* 忽略 */ }
      };
      // 循环结束后的收尾事件要绕过 accepted 检查：此时 accepted 可能
      // 因「上游 4xx」为 false，但错误本身必须告诉前端
      const sendFinal = (obj) => {
        if (!settled) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          settled = true;
          sendMeta();
        }
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* 忽略 */ }
      };

      for (let i = 0; i < 3 && !settled; i++) {
        const item = pool.pick(tried);
        if (!item) break;
        tried.add(item.account.id);
        account = item.account;
        text = '';
        accepted = false;

        const r = await pool.callModelStream(
          item.account, '/chat/completions', 'POST', payload,
          (chunk) => {
            // 非 2xx 时这段是错误体，不能当正文转发
            if (!accepted) return;
            text += chunk;
            // 上游 SSE 增量转成前端好用的格式：前端不必再解一遍
            // OpenAI 的 chunk 结构，也便于把 reasoning 与正文分开显示
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const p = line.slice(5).trim();
              if (!p || p === '[DONE]') continue;
              try {
                const j = JSON.parse(p);
                const d = ((j.choices || [])[0] || {}).delta || {};
                if (d.reasoning_content) send({ type: 'reasoning', text: d.reasoning_content });
                if (d.content) send({ type: 'delta', text: d.content });
              } catch (e) { /* 非 JSON 行跳过 */ }
            }
          },
          {
            timeout: 600000,
            onStatus: (code) => {
              // 状态码决定「这次响应能不能用」；能用的才把后续 chunk
              // 当正文转发，不能用的让循环换账号
              if (code >= 200 && code < 300) accepted = true;
              else { upstreamStatus = code; upstreamErr = `HTTP ${code}`; }
            },
          },
        );

        upstreamStatus = r.status || upstreamStatus || 0;
        if (r.ok && accepted) {
          usage = reqlog.usageFromSSE(text);
          break;
        }
        upstreamErr = r.error || upstreamErr || `HTTP ${r.status}`;
        // 4xx（除 401/429）是请求本身的问题，换账号也一样失败
        if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) break;
      }

      if (!settled) {
        return sendJSON(res, upstreamStatus || 503, { error: upstreamErr || '没有可用账号（全部禁用或冷却中）' });
      }

      const cost = upstreamErr ? null : costOf(account.id, before, await snapshotBalances());

      reqlog.record({
        ts: Date.now(), ms: Date.now() - startedAt,
        first_token_ms: null,
        path: '/admin/chatlab', model: model || mapped, mapped_model: mapped,
        stream: true, messages: messages.length,
        status: upstreamStatus || 0,
        input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.total,
        ip: reqlog.clientIP(req), ua: 'admin-chatlab',
        key_id: 0, key: '', upstream: 'web',
        // 同非流式分支：走的是搭子上游，凭证来自网页 cookie
        channel: 'dumate',
        account: account.name,
        error: upstreamErr,
      });
      // 与请求日志同一条余额游标链：「本次消耗」和日志里的实测值才能对上
      if (!upstreamErr) pointsCursor.capture(Date.now(), account.name);

      if (upstreamErr) sendFinal({ type: 'error', error: upstreamErr });
      sendFinal({ type: 'done', usage, account: account.name, cost });
      res.end();
    },
  },
];

module.exports = { routes };
