// dumate2api - Main server: OpenAI pass-through + Anthropic translation
const http = require('http');
const { discoverPort, verifyPort } = require('./discovery');
const { mapModel, anthropicToOpenAI, openAIToAnthropic, mapFinishReason } = require('./anthropic');
const { googleToOpenAI, openAIToGoogle, translateStreamToGoogle } = require('./google');
const { responsesToOpenAI, openAIToResponse, translateStreamToResponses } = require('./responses');
const { resolveMaxTokens, resolveQwenMaxTokens } = require('./budget');

// 按通道选用预算策略。收敛在这里而不是在四个调用点各写一遍 if——
// 分开写必然漂移（曾经就漏了千问，导致小预算直接截断正文）。
// 千问的下限远低于搭子（4096 vs 32768），因为它的 reasoning 峰值只有百级。
function resolveBudget(target, requested) {
  return target && target.budgetKind === 'qwenwork'
    ? resolveQwenMaxTokens(requested)
    : resolveMaxTokens(requested);
}
const reqlog = require('./reqlog');
const pointsCursor = require('./points-cursor');
const modelmap = require('./modelmap');
const keysvc = require('./keys');
const router = require('./upstream-router');

const PROXY_PORT = parseInt(process.env.DUMATE2API_PORT || '9080', 10);
const PROXY_HOST = process.env.DUMATE2API_HOST || '127.0.0.1';
const API_KEY = process.env.DUMATE2API_KEY || 'nokey';
// 默认关闭。开启后所有模型端点要求带已登记的 API key。
const REQUIRE_KEY = process.env.DUMATE_REQUIRE_KEY === '1';

let upstreamPort = null;
let upstreamManaged = false;
let qwenworkUp = null; // 千问办公通道端口；null = 本次启动未就绪
let lastDiscoveryTime = 0;
const DISCOVERY_INTERVAL = 30000; // re-discover every 30s if port changes

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function ensureUpstream() {
  const now = Date.now();
  if (upstreamPort && now - lastDiscoveryTime < DISCOVERY_INTERVAL) {
    return upstreamPort;
  }
  const port = await discoverPort();
  if (port) {
    if (port !== upstreamPort) {
      log(`Discovered DuMate main-server on port ${port}`);
    }
    upstreamPort = port;
    lastDiscoveryTime = now;
    return port;
  }
  // If we have a cached port, keep using it
  if (upstreamPort) return upstreamPort;
  throw new Error('DuMate main-server not found. Is DuMate running?');
}

/**
 * 直连通道（千问办公）的统一入口。
 *
 * 它不是「另一个本地 HTTP 上游」——没有端口，请求由 src/qwenwork/ 自己发到
 * gateway.qwenwork.cn。所以这里不能直接复用 forwardToUpstream。
 *
 * 流式路径刻意复用现有的三个翻译器（Anthropic / Responses / Google）：它们
 * 只需要一个会吐 `data:` 行的 EventEmitter，所以这里用 PassThrough 把
 * provider 的回调转成等价的流，而不是把三套 SSE 状态机各重写一遍。
 */
async function handleDirectChannel(req, res, payload, route, ctx) {
  const { startedAt, info, kind } = ctx;
  const provider = require('./qwenwork');
  const wantStream = !!payload.stream;

  // 请求 id 在这里就定下来：埋点与积分归因两边都要用同一个值才能配对。
  // 归因要等 1.5s 结算，时间戳对不上；靠时间猜会让同秒内的两条请求互相串账。
  if (!req._reqId) req._reqId = reqlog.newReqId();
  const reqId = req._reqId;

  try {
    if (!wantStream) {
      const result = await provider.send(payload, undefined, { reqId });
      const out = kind === 'openai' ? result : result;
      if (kind === 'anthropic') {
        const anth = openAIToAnthropic(out, payload.model);
        logRequest(req, res, startedAt, info, 200, anth.usage || null);
        return sendJSON(res, 200, anth);
      }
      if (kind === 'google') {
        logRequest(req, res, startedAt, info, 200, out.usage || null);
        return sendJSON(res, 200, openAIToGoogle(out, payload.model));
      }
      const usage = out.usage || {};
      logRequest(req, res, startedAt, info, 200, {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        total: usage.total_tokens || 0,
      });
      return sendJSON(res, 200, out);
    }

    // ---- 流式：把 provider 回调桥接成等价的上游响应流 ----
    //
    // 三个翻译器的契约是「喂进来一个会吐 `data:` 行的上游响应，往 res 写」。
    // 所以这里只造一个 PassThrough 冒充上游响应，**res 原样传给翻译器**——
    // 它是真的 http.ServerResponse，writeHead/write/end 全都齐备，
    // 比手搓一个鸭子类型的 sink 稳得多（翻译器内部还会挂 'close' 之类的监听）。
    // 这样三套 SSE 状态机（Anthropic 的 block 顺序、Responses 的事件序列、
    // Google 的分片）都能原样复用，不必为直连通道各重写一遍。
    const { PassThrough } = require('stream');
    const shim = new PassThrough();

    // 流式累计正文，供结束时的埋点取 token（OpenAI 路径原本没有任何
    // 落埋点的地方——千问的流式请求因此从不出现在请求日志里）。
    // 只保留尾部窗口：usage 只在最后一两个块里，而流可以活很久。
    let seen = '';
    const TAIL = 32768;
    let logged = false;

    const done = (usage, status) => {
      if (logged) return;
      logged = true;
      logRequest(req, res, startedAt, info, status || 200, usage || null);
    };

    // OpenAI 路径专用的延迟响应头。翻译器分支各自会 writeHead，只有
    // OpenAI 分支没有翻译器，需要我们自己发头——且**必须推迟到第一帧**：
    // 上游错误（如 `403 Model is not available`）是在流里才暴露的，若一进来
    // 就 writeHead(200)，等发现是错误时头已发出，改不成 4xx，客户端只能看到
    // 一个空的 200 —— 静默失败，最难排查的那种。
    let writeSSEHead = null;

    if (kind === 'anthropic') {
      translateStreamToAnthropic(shim, res, payload.model, done);
    } else if (kind === 'responses') {
      translateStreamToResponses(shim, res, payload.model, done);
    } else if (kind === 'google') {
      translateStreamToGoogle(shim, res, payload.model, done);
    } else {
      // OpenAI 路径：无翻译，把 shim 直接接到 res。
      // pipe 不能漏——翻译器分支是「翻译器读 shim 写 res」，OpenAI 分支没有
      // 翻译器，不 pipe 就无人转发，客户端拿到 0 字节且流永不结束。
      writeSSEHead = () => {
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
      };
      shim.once('data', writeSSEHead);
      shim.pipe(res);
    }

    (async () => {
      try {
        await provider.send(payload, (inner) => {
          if (inner === '[DONE]') {
            // 按 OpenAI 规范补发结束标记再关流。千问上游本身不发
            // `data: [DONE]`（它用 event:finish 收尾），但客户端按规范等这个
            // 标记；只靠流关闭会让部分客户端（如 Codex）认为响应未完成。
            writeSSEHead && writeSSEHead();
            shim.write('data: [DONE]\n\n');
            shim.end();
            return;
          }
          // 首字时刻：直连通道的 first_token_ms 全靠这里标，
          // 不标则请求日志里千问的「首字延迟」永远是空
          markFirstToken(res);
          // OpenAI 路径没有翻译器，得在这里自己扫 usage。
          // **必须补上 `data: ` 前缀**：inner 是解信封后的裸 JSON，
          // 而 usageFromSSE 按 `data:` 行扫描——不补前缀就永远扫不到，
          // 流式请求的 token 会一直记成 0。
          seen += `data: ${inner}\n`;
          if (seen.length > TAIL) seen = seen.slice(-TAIL);
          shim.write(`data: ${inner}\n\n`);
        }, { reqId });
        shim.end();
        // OpenAI 路径的收尾埋点。翻译器分支各自在 done 里记，
        // 只有这里没有——不补上，千问的流式请求就不进请求日志。
        if (kind === 'openai') done(reqlog.usageFromSSE(seen), 200);
      } catch (e) {
        // 顺序很关键：**先 unpipe 再 end**。
        // shim 已经 pipe 到 res，若直接 shim.end()，pipe 会把 res 一并结束
        // （发成 200 空响应），等想回 4xx JSON 时头已发出、改不回来了。
        try { shim.unpipe(res); } catch (e2) { /* 未 pipe */ }
        try { shim.end(); } catch (e2) { /* 已结束 */ }
        const status = e.statusCode || 502;
        done(null, status);
        logRequest(req, res, startedAt, info, status, null, { error: e.message });
        if (!res.headersSent) {
          // 首帧前就失败：回正经的 4xx JSON，客户端能看懂
          try {
            sendJSON(res, status, { error: { message: e.message, type: 'api_error' } });
          } catch (e2) { /* 已结束 */ }
        } else {
          // 已经吐过帧了，只能在流内收尾——不能再发 JSON 错误体，
          // 否则客户端会在同一个流里收到半截 SSE + 一段 JSON。
          try { res.end(); } catch (e2) { /* 已结束 */ }
        }
      }
    })();
  } catch (e) {
    const status = e.statusCode || 502;
    logRequest(req, res, startedAt, info, status, null, { error: e.message });
    return sendJSON(res, status, { error: { message: e.message, type: 'api_error' } });
  }
}

// Forward request to DuMate upstream
//
// callback 只允许被调用一次：上游 socket 出错（含客户端主动 destroy）时
// Node 会同时触发 error 与后续事件，重复调用会让响应被写两次、
// 客户端永久挂在半开的流上（表现为「输出突然停止」）。
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.DUMATE_UPSTREAM_TIMEOUT_MS || '600000', 10);

function forwardToUpstream(portOrTarget, path, method, headers, body, callback) {
  let settled = false;
  const once = (arg) => { if (!settled) { settled = true; callback(arg); } };

  // 两种调用形态：
  //   forwardToUpstream(8980, ...)                 ← 老签名，等价于搭子 target
  //   forwardToUpstream({host,port,basePath,...})  ← 路由后的 target
  // 保留老签名是因为 stable/ 快照与外部调用点都按数字端口写，改签名会波及
  // 到不该动的代码。归一化放在这里，调用方不用关心。
  const t = (typeof portOrTarget === 'object' && portOrTarget !== null)
    ? portOrTarget
    : { host: '127.0.0.1', port: portOrTarget, basePath: '/api/qianfanproxy/v1', authHeader: 'Bearer nokey' };
  const basePath = t.basePath || '/api/qianfanproxy/v1';

  const options = {
    host: t.host || '127.0.0.1',
    port: t.port,
    path: `${basePath}${path}`,
    method: method,
    timeout: UPSTREAM_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      // 千问通道要带它自己那把 Key；搭子是固定的 Bearer nokey。
      // authHeader 为 null 说明 key 文件缺失，此时不塞 Authorization，
      // 让上游回 401 —— 比在这里伪造一个空 Bearer 更容易定位。
      ...(t.authHeader ? { 'Authorization': t.authHeader } : {}),
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
    }
  };

  const req = http.request(options, (upstreamRes) => {
    // 上游响应中途断开时，把中断交给下游 handler 收尾（各 handler 都监听了
    // 'error' 或 'end'）。这里不能吞掉，否则客户端会挂在半开的流上。
    upstreamRes.on('error', () => {});
    once(upstreamRes);
  });

  req.on('error', (err) => {
    once({
      fakeResponse: true,
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      write: () => {},
      end: () => {}
    });
  });
  req.on('timeout', () => {
    req.destroy(new Error('upstream timeout after ' + UPSTREAM_TIMEOUT_MS + 'ms'));
  });
  if (body) req.write(body);
  req.end();
  return req;
}

function readBody(req) {
  // 鉴权阶段可能已经为模型白名单预读过请求体；流只能消费一次，
  // 直接返回缓存，否则 handler 拿到空串
  if (typeof req._rawBody === 'string') return Promise.resolve(req._rawBody);
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// 收全上游响应体后回调一次。end / aborted / error 三路都以同一入口收尾，
// 避免上游中途断开时下游永远等不到回调（「输出停止」类故障的根因之一）。
function collectAndFinish(upstreamRes, onComplete) {
  let data = '';
  let done = false;
  const finish = () => { if (!done) { done = true; onComplete(data); } };
  upstreamRes.on('data', (c) => data += c);
  upstreamRes.on('end', finish);
  upstreamRes.on('aborted', finish);
  upstreamRes.on('error', finish);
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// 埋点辅助：把一次请求的结局写进 requests.jsonl。
// 用 res 上的标记保证同一次请求只记一行——流式路径会同时挂 end/error/aborted
// 三个收尾点，不挡一下就会记出重复条目。
function logRequest(req, res, startedAt, info, status, usage, extra) {
  if (res._logged) return;
  res._logged = true;
  const u = usage || { input: 0, output: 0, total: 0 };
  const h = req.headers || {};
  const ts = Date.now();
  // req_id 优先取请求上已生成的（千问直连通道要把它传给积分归因，
  // 两边必须用同一个 id 才能配对），没有则现生成一个
  const reqId = req._reqId || reqlog.newReqId();
  req._reqId = reqId;
  reqlog.record({
    ts,
    req_id: reqId,
    ms: Date.now() - startedAt,
    // 首字延迟：从收到请求到上游吐出第一个字节。总耗时无法反映这一点——
    // 一个 30 秒的请求可能 0.5 秒就出字、也可能 20 秒才出字，
    // 后者才是用户感知到的「卡」。
    first_token_ms: res._firstTokenAt ? res._firstTokenAt - startedAt : null,
    path: req._logPath || '',
    // 通道：区分请求走的是搭子还是千问办公。不加这个字段，两侧的首字延迟
    // 会混在同一个均值里（千问首帧实测 6.7s，搭子不是），且无法归因。
    channel: req._channel || 'dumate',
    model: info.model || '',
    // 映射后的模型：客户端发来的名字经 modelmap 转换后实际打给上游的值。
    // 排查「为什么 glm-5 变成了 model-text」这类问题时要看它。
    mapped_model: req._mappedModel || '',
    stream: !!info.stream,
    messages: info.messages || 0,
    status: status || 0,
    input_tokens: u.input || 0,
    output_tokens: u.output || 0,
    total_tokens: u.total || 0,
    ip: reqlog.clientIP(req),
    // 客户端标识：区分 Codex / Claude Code / 其它调用方，排查兼容问题时最先看这个
    ua: String(h['user-agent'] || '').slice(0, 200),
    // 记 id 而不是名字：名字可改，改名后按名字聚合的历史会全部对不上号。
    // 名称另存一份，便于日志直接可读。
    key_id: (req._apiKey && req._apiKey.id) || 0,
    key: (req._apiKey && req._apiKey.name) || '',
    ...(extra || {}),
  });

  // 余额游标：请求结束后记一次余额，与上一次的差值就是这条请求的实际扣费。
  // 上游账单归因不可靠（实测同一请求时间窗内有 1~3 条候选，无法唯一对应），
  // 所以改用实测余额差。不 await——采集在响应发出后进行，不占请求延迟。
  if (status && status < 500 && (u.input || u.output || (extra && extra.account))) {
    pointsCursor.capture(ts, (extra && extra.account) || '');
  }
}

// 标记首字时刻。多次调用只记第一次——流式响应会持续吐字节，
// 我们要的是「第一个」，不是最后一个。
function markFirstToken(res) {
  if (!res._firstTokenAt) res._firstTokenAt = Date.now();
}

// ==================== OpenAI Compatible Endpoints ====================

async function handleOpenAIModels(req, res) {
  // 条目来自 modelmap（可经管理端编辑），不再硬编码：
  // 之前这里的列表与 anthropic.js 的 MODEL_MAP 各写一份，会各自漂移。
  const cfg = modelmap.load();
  const created = Math.floor(Date.now() / 1000);
  const upstream = new Set(cfg.upstream_models);
  const data = cfg.exposed.map((id) => ({
    id,
    object: 'model',
    created,
    // 区分「上游直接认识」与「靠别名转换」——后者换名字也能用，
    // 但前者才是上游真实模型，界面与客户端据此判断
    owned_by: upstream.has(id) ? 'dumate' : 'dumate-proxy',
  }));

  // 千问办公的模型带 qwen/ 前缀列出来，否则客户端无从发现这个通道
  // （它们不在 modelmap 里——那套别名是搭子专用的）。
  // 列不出来时静默跳过：通道不可用不该让整个 /v1/models 失败。
  if ((process.env.DUMATE_QWENWORK_AUTOSTART || 'auto') !== 'off') {
    try {
      const qw = require('./qwenwork');
      const models = await qw.listModels();
      for (const m of router.exposedFor('qwenwork', models)) {
        data.push({ id: m, object: 'model', created, owned_by: 'qwenwork' });
      }
    } catch (e) { /* 通道不可用，不列 */ }
  }

  sendJSON(res, 200, { object: 'list', data });
}

async function handleOpenAIChat(req, res) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  let reqBody;
  try {
    reqBody = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }

  const info = reqlog.describeRequest(reqBody);
  req._logPath = '/v1/chat/completions';

  // 通道分流：`qwen/xxx` 走千问办公，其余走搭子。
  // 必须在 mapModel 之前——千问的模型名（pro/flash）不在搭子的别名表里，
  // 先过 mapModel 会被兜底成 model-text，等于把请求打到错的模型上。
  const route = router.resolve(reqBody.model);
  if (route.error) {
    return sendJSON(res, 400, { error: { message: route.error, type: 'invalid_request_error' } });
  }
  const avail = router.availability(route.channel);
  if (!avail.ok) {
    return sendJSON(res, 503, {
      error: { message: `channel ${route.channel} unavailable: ${avail.reason}`, type: 'api_error' }
    });
  }
  req._channel = route.channel;
  req._mappedModel = route.model;

  if (route.target.needsModelMap) {
    reqBody.model = mapModel(route.model);
    req._mappedModel = reqBody.model;
  } else {
    reqBody.model = route.model;
  }

  // 预算统一由 budget.js 判定：glm 的 reasoning 与正文共用一个 max_tokens
  // 预算，小预算会让正文被 reasoning 吃光（实测 max_tokens<=1024 时正文为空，
  // finish_reason=length）。
  // 千问办公不套这一档：实测它的推理与正文分开流（reasoning 2060 字 / 正文
  // 96 字），机制不同，套上搭子的 32768 下限只会把小请求凭空撑大。
  if (route.target.needsBudget) {
    reqBody.max_tokens = resolveBudget(route.target, reqBody.max_tokens);
  }

  const target = route.target;

  // 千问办公是直连通道（没有本地端口），走 provider 而不是转发。
  // 在 mapModel / 预算之后、转发之前分流——它的 body 构造与搭子不同，
  // 且要经官方 wasm 封装。
  if (target.direct) {
    return await handleDirectChannel(req, res, reqBody, route, { startedAt, info, kind: 'openai' });
  }

  if (target.id === 'dumate') {
    target.port = await ensureUpstream();
  }
  const outBody = JSON.stringify(reqBody);

  const upstreamReq = forwardToUpstream(target, '/chat/completions', 'POST', {}, outBody, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_unavailable' });
      return sendJSON(res, 502, { error: { message: 'DuMate upstream unavailable', type: 'api_error' } });
    }

    if (reqBody.stream) {
      // Pass-through streaming
      res.writeHead(upstreamRes.statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      // 上游中途断开时必须主动收尾，否则客户端挂在半开的流上
      // （表现为「输出写到一半就停住，一直不返回」）。
      // 顺路扫 SSE 取真实 usage：流式响应没有单一 usage 字段。
      // usage 只在最后一两个块里，所以只保留尾部固定窗口——原实现一直累积
      // 到 200KB 且从不截断，而流可以活 55 秒以上，并发流就是 N×200KB。
      let seen = '';
      const TAIL = 32768;
      // StringDecoder：跨 chunk 的汉字不能逐块解码（会变 U+FFFD），
      // 而这里要扫的是 SSE 文本里的 usage，乱码会让匹配失准
      const seenDec = new (require('string_decoder').StringDecoder)('utf8');
      upstreamRes.on('data', (c) => {
        markFirstToken(res);
        seen += seenDec.write(c);
        if (seen.length > TAIL) seen = seen.slice(-TAIL);
      });
      const finishStream = () => {
        logRequest(req, res, startedAt, info, upstreamRes.statusCode, reqlog.usageFromSSE(seen));
        res.end();
      };
      upstreamRes.on('aborted', finishStream);
      upstreamRes.on('error', finishStream);
      upstreamRes.on('end', () => {
        logRequest(req, res, startedAt, info, upstreamRes.statusCode, reqlog.usageFromSSE(seen));
      });
      upstreamRes.pipe(res);
    } else {
      // Pass-through non-streaming
      let data = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        let usage = null;
        try {
          const j = JSON.parse(data);
          usage = reqlog.pickUsage(j.usage);
        } catch (e) { /* 非 JSON 就按 0 记 */ }
        logRequest(req, res, startedAt, info, upstreamRes.statusCode, usage);
        res.writeHead(upstreamRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      };
      upstreamRes.on('data', (c) => {
        markFirstToken(res);
        data += c;
      });
      upstreamRes.on('end', finish);
      upstreamRes.on('aborted', finish);
      upstreamRes.on('error', finish);
    }
  });
}

// Rough token estimate. DuMate exposes no tokenizer, so bytes/4 is a
// deliberately conservative stand-in that keeps Claude Code happy.
function estimateTokens(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / 4);
  if (Array.isArray(value)) {
    return value.reduce((acc, b) => {
      if (typeof b === 'string') return acc + Math.ceil(b.length / 4);
      if (b && typeof b === 'object') {
        const t = typeof b.text === 'string' ? b.text : JSON.stringify(b.input || b.content || '');
        return acc + Math.ceil(t.length / 4);
      }
      return acc;
    }, 0);
  }
  return Math.ceil(String(value).length / 4);
}

async function handleAnthropicCountTokens(req, res) {
  const bodyStr = await readBody(req);
  let body;
  try {
    body = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
  }
  let total = estimateTokens(body.system);
  for (const m of (body.messages || [])) total += estimateTokens(m.content) + 4;
  for (const t of (body.tools || [])) total += estimateTokens(t.description || '') + estimateTokens(JSON.stringify(t.input_schema || {}));
  return sendJSON(res, 200, { type: 'count_tokens_result', input_tokens: total });
}

// ==================== Google Generative Language (v1beta) Compatible Endpoints ====================

async function handleGoogleModels(req, res) {
  sendJSON(res, 200, {
    models: [
      { name: 'models/glm-5', displayName: 'GLM-5', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
      { name: 'models/model-text', displayName: 'DuMate text', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
      { name: 'models/claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet (proxy)', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
      { name: 'models/gpt-4o', displayName: 'GPT-4o (proxy)', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
    ],
  });
}

async function handleGoogleGenerateContent(req, res, isStream, pathModel) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  let googleReq;
  try {
    googleReq = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { code: 400, message: 'Invalid JSON body', status: 'INVALID_ARGUMENT' } });
  }

  googleReq.stream = isStream;
  // Google 的模型名在 URL 路径上，body 里没有，埋点要显式带上
  const info = reqlog.describeRequest(googleReq, pathModel);
  req._logPath = '/v1beta:generateContent';

  const openaiReq = googleToOpenAI(googleReq);
  req._mappedModel = openaiReq.model;

  // 通道分流：Google 路径的模型名来自 URL，googleToOpenAI 已把它落到
  // openaiReq.model，所以这里与 chat 路径共用同一套解析。
  const route = router.resolve(openaiReq.model);
  if (route.error) {
    return sendJSON(res, 400, { error: { message: route.error, code: 400, status: 'INVALID_ARGUMENT' } });
  }
  const avail = router.availability(route.channel);
  if (!avail.ok) {
    return sendJSON(res, 503, { error: { message: `channel ${route.channel} unavailable: ${avail.reason}`, code: 503, status: 'UNAVAILABLE' } });
  }
  req._channel = route.channel;

  if (route.target.needsModelMap) {
    openaiReq.model = mapModel(route.model);
    req._mappedModel = openaiReq.model;
  } else {
    openaiReq.model = route.model;
    req._mappedModel = route.model;
  }
  if (route.target.needsBudget) {
    openaiReq.max_tokens = resolveBudget(route.target, openaiReq.max_tokens);
  }
  const target = route.target;
  if (target.direct) {
    openaiReq.stream = isStream;
    return await handleDirectChannel(req, res, openaiReq, route, { startedAt, info, kind: 'google' });
  }
  if (target.id === 'dumate') target.port = await ensureUpstream();
  const outBody = JSON.stringify(openaiReq);
  forwardToUpstream(target, '/chat/completions', 'POST', {}, outBody, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_unavailable' });
      return sendJSON(res, 502, { error: { code: 502, message: 'DuMate upstream unavailable', status: 'UNAVAILABLE' } });
    }

    // 上游报错时必须把状态码透出去。原实现在这里不检查 statusCode 就
    // writeHead(200)，于是 429/500 被翻译成「HTTP 200 + 空候选」，
    // 客户端以为成功、拿到的却是空回答。
    if (upstreamRes.statusCode >= 400) {
      return collectAndFinish(upstreamRes, (data) => {
        logRequest(req, res, startedAt, info, upstreamRes.statusCode, null, { error: 'upstream_error' });
        sendJSON(res, upstreamRes.statusCode, {
          error: { code: upstreamRes.statusCode, message: 'Upstream error: ' + data.substring(0, 300), status: 'UNAVAILABLE' },
        });
      });
    }

    if (isStream) {
      // Google streaming supports both ?alt=sse and bare streamGenerateContent.
      translateStreamToGoogle(upstreamRes, res, googleReq.model, (usage, status) => {
        logRequest(req, res, startedAt, info, status, usage);
      });
    } else {
      let data = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          const openaiResp = JSON.parse(data);
          logRequest(req, res, startedAt, info, 200, reqlog.pickUsage(openaiResp.usage));
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify(openAIToGoogle(openaiResp, googleReq.model)));
        } catch (e) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'parse_error' });
          sendJSON(res, 502, { error: { code: 502, message: 'Upstream parse error: ' + data.substring(0, 200), status: 'INTERNAL' } });
        }
      };
      upstreamRes.on('data', (c) => data += c);
      upstreamRes.on('end', finish);
      upstreamRes.on('aborted', finish);
      upstreamRes.on('error', finish);
    }
  });
}

// ==================== OpenAI Responses API (Codex CLI) ====================

async function handleOpenAIResponses(req, res) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  let reqBody;
  try {
    reqBody = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }

  const isStream = reqBody.stream !== false; // Codex 默认流式
  const info = reqlog.describeRequest(reqBody);
  req._logPath = '/v1/responses';

  const openaiReq = responsesToOpenAI(reqBody, isStream);
  req._mappedModel = openaiReq.model;

  // 通道分流：Codex 的 responses 接口同样支持 qwen/ 前缀
  const route = router.resolve(openaiReq.model);
  if (route.error) {
    return sendJSON(res, 400, { error: { message: route.error, type: 'invalid_request_error' } });
  }
  const avail = router.availability(route.channel);
  if (!avail.ok) {
    return sendJSON(res, 503, { error: { message: `channel ${route.channel} unavailable: ${avail.reason}`, type: 'api_error' } });
  }
  req._channel = route.channel;

  if (route.target.needsModelMap) {
    openaiReq.model = mapModel(route.model);
    req._mappedModel = openaiReq.model;
  } else {
    openaiReq.model = route.model;
    req._mappedModel = route.model;
  }
  if (route.target.needsBudget) {
    openaiReq.max_tokens = resolveBudget(route.target, openaiReq.max_tokens);
  }
  const target = route.target;
  if (target.direct) {
    openaiReq.stream = isStream;
    return await handleDirectChannel(req, res, openaiReq, route, { startedAt, info, kind: 'responses' });
  }
  if (target.id === 'dumate') target.port = await ensureUpstream();
  const outBody = JSON.stringify(openaiReq);
  forwardToUpstream(target, '/chat/completions', 'POST', {}, outBody, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_unavailable' });
      return sendJSON(res, 502, { error: { message: 'DuMate upstream unavailable', type: 'api_error' } });
    }
    if (!upstreamRes.statusCode || upstreamRes.statusCode >= 400) {
      return collectAndFinish(upstreamRes, (data) => {
        logRequest(req, res, startedAt, info, upstreamRes.statusCode || 502, null, { error: 'upstream_error' });
        sendJSON(res, upstreamRes.statusCode || 502, {
          error: { message: 'Upstream error: ' + data.substring(0, 300), type: 'api_error' },
        });
      });
    }

    if (isStream) {
      translateStreamToResponses(upstreamRes, res, reqBody.model, (usage, status) => {
        logRequest(req, res, startedAt, info, status, usage);
      });
    } else {
      collectAndFinish(upstreamRes, (data) => {
        try {
          const openaiResp = JSON.parse(data);
          logRequest(req, res, startedAt, info, 200, reqlog.pickUsage(openaiResp.usage));
          sendJSON(res, 200, openAIToResponse(openaiResp, reqBody.model));
        } catch (e) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'parse_error' });
          sendJSON(res, 502, { error: { message: 'Upstream parse error: ' + data.substring(0, 200), type: 'api_error' } });
        }
      });
    }
  });
}

// ==================== Anthropic Compatible Endpoints ====================

async function handleAnthropicMessages(req, res) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  let anthropicReq;
  try {
    anthropicReq = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
  }

  const info = reqlog.describeRequest(anthropicReq);
  req._logPath = '/v1/messages';

  // Convert to OpenAI format
  const openaiReq = anthropicToOpenAI(anthropicReq);
  req._mappedModel = openaiReq.model;

  // 通道分流：与 chat 路径同一套规则，且必须在转换之后——Anthropic 请求体
  // 的模型名在这里才落到 openaiReq.model 上。
  const route = router.resolve(openaiReq.model);
  if (route.error) {
    return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: route.error } });
  }
  const avail = router.availability(route.channel);
  if (!avail.ok) {
    return sendJSON(res, 503, { type: 'error', error: { type: 'api_error', message: `channel ${route.channel} unavailable: ${avail.reason}` } });
  }
  req._channel = route.channel;

  if (route.target.needsModelMap) {
    openaiReq.model = mapModel(route.model);
    req._mappedModel = openaiReq.model;
  } else {
    openaiReq.model = route.model;
    req._mappedModel = route.model;
  }
  if (route.target.needsBudget) {
    openaiReq.max_tokens = resolveBudget(route.target, openaiReq.max_tokens);
  }
  const target = route.target;
  if (target.direct) {
    openaiReq.stream = !!anthropicReq.stream;
    return await handleDirectChannel(req, res, openaiReq, route, { startedAt, info, kind: 'anthropic' });
  }
  if (target.id === 'dumate') target.port = await ensureUpstream();
  // Ask the upstream for a usage-bearing final chunk so we can report real
  // token counts instead of zeroes. Harmless if the upstream ignores it.
  if (anthropicReq.stream) openaiReq.stream_options = { include_usage: true };
  const outBody = JSON.stringify(openaiReq);

  forwardToUpstream(target, '/chat/completions', 'POST', {}, outBody, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_unavailable' });
      return sendJSON(res, 502, { type: 'error', error: { type: 'api_error', message: 'DuMate upstream unavailable' } });
    }

    if (anthropicReq.stream) {
      // Translate OpenAI SSE stream to Anthropic SSE events
      translateStreamToAnthropic(upstreamRes, res, anthropicReq.model, (usage, status) => {
        logRequest(req, res, startedAt, info, status, usage);
      });
    } else {
      // Non-streaming: collect and translate
      collectAndFinish(upstreamRes, (data) => {
        try {
          const openaiResp = JSON.parse(data);
          const anthropicResp = openAIToAnthropic(openaiResp, anthropicReq.model);
          logRequest(req, res, startedAt, info, upstreamRes.statusCode, reqlog.pickUsage(openaiResp.usage));
          sendJSON(res, 200, anthropicResp);
        } catch (e) {
          sendJSON(res, 502, { type: 'error', error: { type: 'api_error', message: 'Upstream parse error: ' + data.substring(0, 200) } });
        }
      });
    }
  });
}

// Translate OpenAI SSE stream to Anthropic SSE stream
function translateStreamToAnthropic(upstreamRes, res, originalModel, onDone) {
  let finished = false;
  const finish = (status) => {
    if (finished) return;
    finished = true;
    if (onDone) onDone({ input: inputTokens, output: outputTokens, total: inputTokens + outputTokens }, status);
  };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send message_start
  const msgId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 8);
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: originalModel || 'claude-3-5-sonnet-20241022',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  let buffer = '';
  // StringDecoder：跨 chunk 的多字节汉字不能逐块解码，否则出现 U+FFFD
  const decoder = new (require('string_decoder').StringDecoder)('utf8');
  let blockIndex = -1;
  let currentBlockType = null; // 'thinking' or 'text'
  let hasText = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastFinishReason = null;

  upstreamRes.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.substring(6).trim();
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);
        if (chunk.usage) {
          if (chunk.usage.prompt_tokens != null) inputTokens = chunk.usage.prompt_tokens;
          if (chunk.usage.completion_tokens != null) outputTokens = chunk.usage.completion_tokens;
        }
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (!delta) continue;

        // Reasoning content -> thinking block
        if (delta.reasoning_content) {
          if (currentBlockType !== 'thinking') {
            // Close previous block
            if (blockIndex >= 0) {
              sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            }
            blockIndex++;
            currentBlockType = 'thinking';
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'thinking', thinking: '' }
            });
          }
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
          });
        }

        // Content -> text block
        if (delta.content) {
          if (currentBlockType !== 'text') {
            if (blockIndex >= 0) {
              sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            }
            blockIndex++;
            currentBlockType = 'text';
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' }
            });
          }
          hasText = true;
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: delta.content }
          });
        }

        // Finish reason
        const finishReason = chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason;
        if (finishReason) lastFinishReason = finishReason;
      } catch (e) {
        // ignore parse errors
      }
    }
  });

  upstreamRes.on('end', () => {
    // Close any open block
    if (blockIndex >= 0) {
      sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }
    // If no content was generated, add an empty text block
    if (!hasText && blockIndex < 0) {
      sendEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      });
      sendEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '' }
      });
      sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
    }
    sendEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(lastFinishReason), stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    });
    sendEvent('message_stop', { type: 'message_stop' });
    finish(200);
    res.end();
  });

  upstreamRes.on('error', () => {
    sendEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(lastFinishReason), stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    });
    sendEvent('message_stop', { type: 'message_stop' });
    finish(502);
    res.end();
  });
}

// ==================== Server ====================

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  // 兜住异步 handler 的拒绝。原来只包了同步 try/catch，而 handler 是 async：
  // `await ensureUpstream()` 抛错时（例如网关先于 DuMate 启动——启动日志里
  // 明确提示「Will retry on first request」就是这条路径）拒绝会绕过同步
  // catch，既不写响应（客户端永久挂起），又变成 unhandledRejection 让进程退出。
  const fail = (err) => {
    log('Error:', err.message);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: { message: err.message, type: 'api_error' } });
    } else {
      res.end();
    }
  };

  try {
    // Health check
    if (url === '/health' || url === '/ping') {
      return sendJSON(res, 200, {
        status: 'ok',
        upstream_port: upstreamPort,
        upstream_managed: upstreamManaged,
        // 通道状态：搭子是主链路，千问是可选。分开报，便于一眼看出
        // 「qwen/ 请求会在哪一步失败」。千问是进程内直连，没有端口，
        // 所以报的是 wasm 版本与登录态而不是 port。
        channels: {
          dumate: { port: upstreamPort, ready: !!upstreamPort },
          qwenwork: {
            direct: true,
            ready: !!(qwenworkUp && router.availability('qwenwork').ok),
            wasm: qwenworkUp || null,
          },
        },
        service: 'dumate2api',
      });
    }

    // ==================== API Key 鉴权（可选）====================
    // 默认关闭：现有 cc-switch / Codex 直连不带 key，一旦默认开启会把
    // 所有人挡在外面。只有显式设 DUMATE_REQUIRE_KEY=1 才校验。
    // 鉴权在路由分发之前统一做，避免以后新增端点时漏挂。
    if (REQUIRE_KEY && url !== '/health' && url !== '/ping') {
      const token = keysvc.tokenFromHeaders(req.headers);
      const key = keysvc.resolve(token);

      // 模型白名单与通道绑定都需要知道请求的是哪个模型。只有 key 真的配了
      // 这两类规则时才预读请求体——否则给默认路径凭空加一次完整读取。
      // 预读的内容存到 req._rawBody，handler 里的 readBody 会直接取用，
      // 不会二次消费流。
      let model = null;
      const hasModelRule = key && Array.isArray(key.model_allowlist) && key.model_allowlist.length > 0;
      const hasChannelRule = key && !!key.channel;
      if ((hasModelRule || hasChannelRule) && req.method === 'POST') {
        // Google 的模型名在 URL 路径里，且**可能带通道前缀**（qwen/pro），
        // 所以不能排除 '/'——早期写成 [^:/?]+ 会把 qwen/pro 截断成匹配失败。
        const gm = url.match(/^\/v1beta\/models\/([^:?]+):/);
        if (gm) {
          model = decodeURIComponent(gm[1]);
        } else {
          const raw = await readBody(req);
          req._rawBody = raw;
          try {
            const parsed = JSON.parse(raw);
            model = parsed && parsed.model ? String(parsed.model) : null;
          } catch (e) { model = null; }
        }
      }
      // 通道绑定判定：靠模型名前缀，与 upstream-router 的分流口径一致。
      // 解析不出来（如 GET /v1/models）就不传通道，validate 会跳过这条规则
      // ——不该因为「无法判定通道」把只读请求拒掉。
      let reqChannel = '';
      if (model) {
        try {
          const r = require('./upstream-router').resolve(model);
          reqChannel = r.channel || '';
        } catch (e) { reqChannel = ''; }
      }

      const verdict = keysvc.validate(key, reqlog.clientIP(req), model, reqChannel);
      if (!verdict.ok) {
        const status = key ? 403 : 401;
        req._logPath = url;
        return sendJSON(res, status, {
          error: {
            message: verdict.reason === 'unknown_key'
              ? 'Invalid or missing API key'
              : `API key rejected: ${verdict.reason}`,
            type: 'authentication_error',
            code: verdict.reason,
          },
        });
      }
      req._apiKey = key;
    }

    // ==================== OpenAI compatible ====================
    // Models list
    if (url === '/v1/models' && req.method === 'GET') {
      return await handleOpenAIModels(req, res);
    }

    // Chat completions (OpenAI format, pass-through with model mapping)
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      return await handleOpenAIChat(req, res);
    }

    // Responses API (Codex CLI 0.155+ 只认 wire_api="responses")
    if ((url === '/v1/responses' || url === '/responses') && req.method === 'POST') {
      return await handleOpenAIResponses(req, res);
    }

    // ==================== Google Generative Language compatible ====================
    const googleModels = url.match(/^\/v1beta\/models$/);
    const googleGenerate = url.match(/^\/v1beta\/models\/([^:?]+):(generateContent|streamGenerateContent)$/);
    if (googleModels && req.method === 'GET') {
      return await handleGoogleModels(req, res);
    }
    if (googleGenerate && req.method === 'POST') {
      return await handleGoogleGenerateContent(req, res, googleGenerate[2] === 'streamGenerateContent', decodeURIComponent(googleGenerate[1]));
    }

    // ==================== Anthropic compatible ====================
    // Messages (Anthropic format, full translation)
    // Some clients (Claude Code / cc-switch) hit the bare path, others the
    // /v1-prefixed one. Accept both.
    if ((url === '/v1/messages' || url === '/messages') && req.method === 'POST') {
      return await handleAnthropicMessages(req, res);
    }

    // Also support /v1/chat/completions for Anthropic-style path
    if (url === '/api/v1/messages' && req.method === 'POST') {
      return await handleAnthropicMessages(req, res);
    }

    if ((url === '/v1/messages/count_tokens' || url === '/messages/count_tokens' || url === '/api/v1/messages/count_tokens') && req.method === 'POST') {
      return await handleAnthropicCountTokens(req, res);
    }

    // 404
    sendJSON(res, 404, { error: { message: `Not found: ${url}`, type: 'invalid_request_error' } });
  } catch (err) {
    fail(err);
  }
});

// Initial discovery and start
async function start() {
  log('Starting dumate2api...');
  log(`Proxy will listen on ${PROXY_HOST}:${PROXY_PORT}`);

  try {
    const port = await discoverPort();
    if (port) {
      const valid = await verifyPort(port);
      if (valid) {
        upstreamPort = port;
        upstreamManaged = port === require('./discovery').MANAGED_PORT && (process.env.DUMATE_AUTOSTART || 'auto') !== 'off';
        lastDiscoveryTime = Date.now();
        log(`✓ DuMate main-server verified on port ${port}` + (upstreamManaged ? ' (headless, no DuMate GUI needed)' : ''));
      } else {
        log(`⚠ Found dumate-main-server on port ${port} but endpoint verification failed`);
        upstreamPort = port; // still try to use it
        lastDiscoveryTime = Date.now();
      }
    } else {
      log('⚠ DuMate main-server not detected. Will retry on first request.');
      log('  Make sure DuMate desktop app is running and logged in.');
    }
  } catch (e) {
    log('⚠ Initial discovery failed:', e.message);
  }
  // 千问办公通道：进程内直连（经官方 wasm），**不需要拉起任何外部服务**。
  // 早期版本走 Buddy2api（8787）中转，后来发现它的 wasm_helper.mjs 本身就是
  // 纯 Node 脚本、Python 只是一层壳，改为直连后少一个进程、少一层鉴权。
  // 预热失败不阻断启动：搭子是主链路，千问只是可选通道。
  if ((process.env.DUMATE_QWENWORK_AUTOSTART || 'auto') !== 'off') {
    try {
      const qwmod = require('./qwenwork');
      const qw = qwmod.warmup();
      const st = qwmod.status();
      qwenworkUp = st.loggedIn ? 'ready' : null;
      log(`✓ QwenWork 通道就绪（wasm ${qw.version}，登录态 ${st.loggedIn ? '已就绪' : '缺失'}）`);
    } catch (e) {
      log('⚠ QwenWork 通道不可用（搭子链路不受影响）:', e.message);
      qwenworkUp = null;
    }
  } else {
    log('· QwenWork 通道已关闭（DUMATE_QWENWORK_AUTOSTART=off）');
  }

  server.listen(PROXY_PORT, PROXY_HOST, () => {
    log(`✓ dumate2api listening on http://${PROXY_HOST}:${PROXY_PORT}`);
    log('');
    log('Endpoints:');
    log('  OpenAI:    http://127.0.0.1:' + PROXY_PORT + '/v1/chat/completions');
    log('  Models:    http://127.0.0.1:' + PROXY_PORT + '/v1/models');
    log('  Anthropic: http://127.0.0.1:' + PROXY_PORT + '/v1/messages');
    log('  Health:    http://127.0.0.1:' + PROXY_PORT + '/health');
    log('');
    log('cc-switch configuration:');
    log('  Claude Code: Base URL = http://127.0.0.1:' + PROXY_PORT + ', API Key = nokey');
    log('  Codex:       Base URL = http://127.0.0.1:' + PROXY_PORT + '/v1, API Key = nokey');
  });
}

start().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
