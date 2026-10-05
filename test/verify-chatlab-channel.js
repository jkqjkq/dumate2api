// test/verify-chatlab-channel.js - 聊天测试台的通道分流（离线）
//
// 修的问题：试调台选了 `qoder/xxx` 却跑到百度搭子上去。
// 根因是路由里一律 `modelmap.mapModel(model)`——`qoder/gfmodel` 不在搭子别名表里，
// 被兜底成 `model-text`，于是请求打到搭子网页池，且两侧都返回 200，看不出来。
// 千问与 TRAE 同样中招。
//
// 离线：不打任何真实上游，只用打桩 provider 验证「哪个通道走了哪个 provider」。
const assert = require('assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

// ---- 打桩 provider：记录自己被调用时收到的模型名 ----
const calls = [];
function makeProvider(id) {
  return {
    id,
    async send(payload, onChunk) {
      calls.push({ provider: id, model: payload.model, stream: !!onChunk });
      if (onChunk) {
        // 模拟两帧正文 + 一帧 usage
        onChunk(JSON.stringify({ choices: [{ delta: { content: '你好' } }] }));
        onChunk(JSON.stringify({
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        return { streamed: true };
      }
      return {
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  };
}

const fakeProviders = {
  qoder: makeProvider('qoder'),
  traework: makeProvider('traework'),
  qwenwork: makeProvider('qwenwork'),
};

// 在 require chatlab 之前把 provider 换掉：chatlab 内部是 require('../../qoder')
// 这种懒加载，所以改 require.cache 就能生效
for (const [id, stub] of Object.entries(fakeProviders)) {
  const p = path.join(REPO, 'src', id, 'index.js');
  require.cache[require.resolve(p)] = { id: p, filename: p, loaded: true, exports: stub };
}

const { routes } = require(path.join(REPO, 'src/admin/routes/chatlab'));
const router = require(path.join(REPO, 'src/upstream-router'));

const chatRoute = routes.find((r) => r.path === '/chat');
const modelsRoute = routes.find((r) => r.path === '/qoder-models');

function fakeRes() {
  const out = { status: 0, chunks: [], headers: null };
  return {
    out,
    writeHead(s, h) { out.status = s; out.headers = h; },
    write(s) { out.chunks.push(String(s)); },
    end(s) { if (s) out.chunks.push(String(s)); out.ended = true; },
  };
}

function fakeReq() {
  return { headers: {}, url: '/chat', socket: { remoteAddress: '127.0.0.1' } };
}

/** 跑一次 /chat，返回 { status, json, providerCalls } */
async function chat(body) {
  calls.length = 0;
  const r = fakeRes();
  await chatRoute.handler({ res: r, req: fakeReq(), body });
  const text = r.out.chunks.join('');
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON（流式是 SSE） */ }
  return { status: r.out.status, json, text, providerCalls: calls.slice() };
}

/** 跑一次流式 /chat，返回解析出的事件序列 */
async function chatStream(body) {
  calls.length = 0;
  const r = fakeRes();
  await chatRoute.handler({ res: r, req: fakeReq(), body: { ...body, stream: true } });
  const events = [];
  for (const part of r.out.chunks.join('').split('\n\n')) {
    const line = part.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch (e) { /* skip */ }
  }
  return { status: r.out.status, events, providerCalls: calls.slice() };
}

(async () => {
  console.log('\n聊天测试台通道分流（离线，打桩 provider）\n');

  console.log('— 模型名 → 通道路由 —');
  ok('qoder/gfmodel 解析到 qoder 通道、上游模型 gfmodel', () => {
    const r = router.resolve('qoder/gfmodel');
    assert.strictEqual(r.channel, 'qoder');
    assert.strictEqual(r.model, 'gfmodel');
  });
  ok('裸 gfmodel 仍归搭子（不带前缀 = 现有配置零改动）', () => {
    const r = router.resolve('gfmodel');
    assert.strictEqual(r.channel, 'dumate');
  });
  ok('未知前缀报错而不是静默回落搭子', () => {
    const r = router.resolve('qwn/pro');
    assert.ok(r.error, 'qwn/pro 应报未知通道');
  });

  console.log('\n— /chat 走对 provider（核心修复）—');
  const q = await chat({ model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hi' }] });
  ok('qoder/qfmodel 调 Qoder provider，不是网页池', () => {
    assert.strictEqual(q.providerCalls.length, 1, '应恰好调一次 provider');
    assert.strictEqual(q.providerCalls[0].provider, 'qoder');
  });
  ok('传给 provider 的模型名已去前缀（qfmodel）', () => {
    // 带前缀传下去的话 Qoder 的 resolveModelKey 会拿到 'qoder/gfmodel' 这种非法 key
    assert.strictEqual(q.providerCalls[0].model, 'qfmodel');
  });
  ok('返回的 mapped_model 是 qfmodel，不是搭子的 model-text', () => {
    assert.strictEqual(q.json.mapped_model, 'qfmodel');
  });

  const tw = await chat({ model: 'traework/DeepSeek-V3', messages: [{ role: 'user', content: 'hi' }] });
  ok('traework/ 模型调 TRAE provider，模型名去前缀', () => {
    assert.strictEqual(tw.providerCalls[0].provider, 'traework');
    assert.strictEqual(tw.providerCalls[0].model, 'DeepSeek-V3');
  });

  const qw = await chat({ model: 'qwen/flash', messages: [{ role: 'user', content: 'hi' }] });
  ok('qwen/flash 调千问 provider，模型名去前缀', () => {
    assert.strictEqual(qw.providerCalls[0].provider, 'qwenwork');
    assert.strictEqual(qw.providerCalls[0].model, 'flash');
  });

  const bad = await chat({ model: 'qwn/pro', messages: [{ role: 'user', content: 'hi' }] });
  ok('未知前缀不静默打搭子，回 400', () => {
    assert.strictEqual(bad.status, 400);
    assert.ok(/未知通道/.test(bad.json.error), `错误信息应说明未知通道，实为 ${bad.json.error}`);
    assert.strictEqual(bad.providerCalls.length, 0, '不该调任何 provider');
  });

  console.log('\n— 直连通道的消耗口径 —');
  ok('测不到消耗时 cost 为 null 且带说明（不补 0）', () => {
    assert.strictEqual(q.json.cost, null);
    assert.ok(q.json.costNote, '应有 costNote 说明去哪看消耗');
  });

  console.log('\n— 流式路径 —');
  const qs = await chatStream({ model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hi' }] });
  ok('流式也走 Qoder provider', () => {
    assert.strictEqual(qs.providerCalls[0].provider, 'qoder');
  });
  ok('流式事件序列含 meta / delta / done', () => {
    const types = qs.events.map((e) => e.type);
    assert.ok(types.includes('meta'), `缺 meta，实为 ${types}`);
    assert.ok(types.includes('delta'), `缺 delta，实为 ${types}`);
    assert.ok(types.includes('done'), `缺 done，实为 ${types}`);
  });
  ok('流式的 token 不为 0（usage 扫描补了 data: 前缀）', () => {
    const done = qs.events.find((e) => e.type === 'done');
    assert.ok(done.usage.total > 0, `usage.total 应 >0，实为 ${JSON.stringify(done.usage)}`);
  });
  ok('流式 meta 带去前缀后的模型名', () => {
    const meta = qs.events.find((e) => e.type === 'meta');
    assert.strictEqual(meta.mapped_model, 'qfmodel');
  });

  console.log('\n— Qoder 模型清单 —');
  const mr = fakeRes();
  await modelsRoute.handler({ res: mr, req: { url: '/qoder-models' } });
  const mj = JSON.parse(mr.out.chunks.join(''));
  ok('清单非空', () => assert.ok(mj.models.length > 0));
  ok('每个条目都带 qoder/ 前缀（不带会被判成搭子）', () => {
    assert.ok(mj.models.every((m) => m.prefixed.startsWith('qoder/')),
      `有条目缺前缀：${mj.models.map((m) => m.prefixed).join(', ')}`);
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
