// 验证：搭子通道脱离客户端的开关与真实失败路径。
//
// **先纠正一个容易误判的点**（2026-10-14 实测）：客户端没装时，回落路径上
// **每个请求并不会跑探测链**。upstream-router 给 dumate 的 defaultPort 是 8980
// 且 portOf() 保证返回有效数字，所以 target.port 恒有值，
// forwardWithFallback 里 `!t.port` 那条分支（会调 ensureUpstream → discoverPort）
// 默认配置下走不到。真实路径是 startForward → 连一次本地 8980 →
// ECONNREFUSED（回环，毫秒级）→ 回调里 tryWebFallback()。
// 所以「给探测失败加静默窗口」是多余的——本测试的第一组断言就是在锁死这一点。
//
// 真正的开销在**启动时**那一次 discoverPort（PowerShell 查询，实测约 3 秒），
// 由 DUMATE_DUMATE_SOURCE=web 跳过。
//
// 全部离线：打桩 discovery（计数）与 fallback-web（伪响应），不碰网络。
const path = require('path');
const http = require('http');
const Module = require('module');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19079;

// ---- 1. 打桩 discovery：计数 discoverPort 调用 ----
const counters = { discoverPort: 0 };
const discoveryPath = require.resolve(path.join(ROOT, 'src/discovery.js'));
const realDiscovery = require(discoveryPath);
require.cache[discoveryPath] = new Module(discoveryPath, null);
require.cache[discoveryPath].filename = discoveryPath;
require.cache[discoveryPath].loaded = true;
require.cache[discoveryPath].exports = Object.assign({}, realDiscovery, {
  // 永远返回 null —— 模拟「客户端已卸载」这个目标场景
  discoverPort: async () => { counters.discoverPort++; return null; },
  verifyPort: async () => false,
});

// ---- 2. 打桩 fallback-web：伪上游响应（形状照抄生产语义）----
const fallbackPath = require.resolve(path.join(ROOT, 'src/fallback-web.js'));
let poolAvailable = true; // 中途可切换，用来验 availability 的分支
function makeFakeResponse() {
  const emitter = new EventEmitter();
  emitter.statusCode = 200;
  emitter.headers = { 'content-type': 'text/event-stream' };
  let flushing = false;
  let ended = false;
  const buffered = [];
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const push = (c) => { if (flushing) emitter.emit('data', c); else buffered.push(c); };
  const flush = () => {
    if (flushing) return;
    flushing = true;
    for (const c of buffered) emitter.emit('data', c);
    buffered.length = 0;
    if (ended) emitter.emit('end');
  };
  const done = new Promise((resolve) => {
    setImmediate(() => {
      resolveReady();
      const frame = (delta, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'glm-5',
        choices: [{ index: 0, delta, finish_reason: finish || null }],
      })}\n\n`;
      push(frame({ role: 'assistant', content: 'web' }));
      push(frame({}, 'stop'));
      push('data: [DONE]\n\n');
      ended = true;
      if (flushing) emitter.emit('end');
      resolve({ ok: true, status: 200, streamed: true });
    });
  });
  return { emitter, done, ready, flush };
}
require.cache[fallbackPath] = new Module(fallbackPath, null);
require.cache[fallbackPath].filename = fallbackPath;
require.cache[fallbackPath].loaded = true;
require.cache[fallbackPath].exports = {
  enabled: () => true,
  available: () => poolAvailable,
  callWebPool: () => makeFakeResponse(),
};

// ---- 3. 起真实 server.js ----
process.env.DUMATE2API_PORT = String(PORT);
process.env.DUMATE2API_HOST = '127.0.0.1';
process.env.DUMATE_AUTOSTART = 'off';
process.env.DUMATE_ADMIN_DATA = path.join(ROOT, 'data');
delete process.env.DUMATE_DUMATE_SOURCE; // 先测 auto
require(path.join(ROOT, 'src/server.js'));

function post() {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true });
    const rq = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
      res.on('error', reject);
    });
    rq.on('error', reject);
    rq.write(d);
    rq.end();
  });
}
function get(pathname) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET' }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    rq.on('error', reject);
    rq.end();
  });
}

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : '  ← ' + (detail || '')}`);
}

(async () => {
  let up = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await get('/ping'); up = true; break; } catch (e) { /* 还没起来 */ }
  }
  if (!up) { console.error('server 未能在 15s 内起监听'); process.exit(1); }

  // ---- 真实路径：请求期间不跑探测链 ----
  const afterBoot = counters.discoverPort;
  assert('启动阶段做了一次初始探测', afterBoot === 1, `实际 ${afterBoot}`);

  let allOk = true;
  for (let i = 0; i < 5; i++) {
    const r = await post();
    if (!(r.status === 200 && r.text.includes('web'))) allOk = false;
  }
  assert('客户端缺失时 5 个请求全部成功（走网页回落）', allOk);
  assert('这 5 个请求**一次探测都没跑**（真实路径是连 8980 失败即回落）',
    counters.discoverPort === afterBoot, `多探了 ${counters.discoverPort - afterBoot} 次`);

  // ---- 显式走网页 ----
  process.env.DUMATE_DUMATE_SOURCE = 'web';
  const beforeForced = counters.discoverPort;
  const r2 = await post();
  assert('DUMATE_DUMATE_SOURCE=web 时请求成功', r2.status === 200 && r2.text.includes('web'), `status ${r2.status}`);
  assert('web 模式下同样零探测', counters.discoverPort === beforeForced);

  // ---- /health 语义 ----
  const h = JSON.parse((await get('/health')).text);
  assert('health: source 报 web', h.channels.dumate.source === 'web', JSON.stringify(h.channels.dumate));
  assert('health: web 模式 ready 看网页池（可用 → true）',
    h.channels.dumate.ready === true, JSON.stringify(h.channels.dumate));

  // ---- availability ----
  const router = require(path.join(ROOT, 'src/upstream-router'));
  assert('availability: web 模式 + 池可用 → ok',
    router.availability('dumate').ok === true);

  poolAvailable = false;
  const notOk = router.availability('dumate');
  assert('availability: web 模式 + 池不可用 → 拒绝', notOk.ok === false, JSON.stringify(notOk));
  assert('availability: 拒绝原因点明是 DUMATE_DUMATE_SOURCE=web',
    /DUMATE_DUMATE_SOURCE=web/.test(notOk.reason || ''), `实际: ${notOk.reason}`);

  const h2 = JSON.parse((await get('/health')).text);
  assert('health: 池不可用时 web 模式 ready=false',
    h2.channels.dumate.ready === false, JSON.stringify(h2.channels.dumate));

  poolAvailable = true;
  delete process.env.DUMATE_DUMATE_SOURCE;

  // ---- 切回 auto 仍能工作 ----
  const r3 = await post();
  assert('切回 auto 后请求仍成功（回落路径没被改坏）',
    r3.status === 200 && r3.text.includes('web'), `status ${r3.status}`);

  // ---- 启动阶段：web 模式跳过那次约 3 秒的初始探测 ----
  // 用子进程跑，因为「是否跳过初始发现」只在启动时决定一次。
  const child = spawnSync(process.execPath, ['-e', `
    process.env.DUMATE_DUMATE_SOURCE = 'web';
    process.env.DUMATE_AUTOSTART = 'off';
    const path = require('path');
    const ROOT = ${JSON.stringify(ROOT)};
    const Module = require('module');
    const dp = require.resolve(path.join(ROOT, 'src/discovery.js'));
    const real = require(dp);
    require.cache[dp] = new Module(dp, null);
    require.cache[dp].filename = dp;
    require.cache[dp].loaded = true;
    require.cache[dp].exports = Object.assign({}, real, {
      discoverPort: async () => { console.log('__PROBED__'); return null; },
    });
    process.env.DUMATE2API_PORT = '19081';
    process.env.DUMATE_ADMIN_DATA = path.join(ROOT, 'data');
    require(path.join(ROOT, 'src/server.js'));
    setTimeout(() => process.exit(0), 4000);
  `], { encoding: 'utf8', timeout: 20000 });

  const out = (child.stdout || '') + (child.stderr || '');
  assert('web 模式启动时不跑初始探测（省掉那约 3 秒）',
    !out.includes('__PROBED__'), '启动阶段仍然调用了 discoverPort');
  assert('web 模式启动日志说明凭证来源',
    /不探测桌面链路/.test(out), '启动日志里没有说明');
  assert('web 模式启动日志不再报「main-server not detected」',
    !/main-server not detected/.test(out), '仍在报桌面链路缺失');

  // ---- 静态防回归 ----
  const src = require('fs').readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  assert('静态检查：forwardWithFallback 里有 forced 分支',
    /DUMATE_DUMATE_SOURCE === 'web'/.test(src), '显式开关被移除了');
  assert('静态检查：没有残留的探测静默窗口（实测证明不需要）',
    !/desktopUnavailableUntil/.test(src), '静默窗口又回来了——那条分支默认走不到');

  const pass = results.filter((x) => x.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
