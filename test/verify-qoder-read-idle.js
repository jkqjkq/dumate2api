// test/verify-qoder-read-idle.js - 验证 Qoder 上游「读空闲」超时
//
// ============================================================
// 为什么要有这个脚本
//
// 2026-10-23~24 实测：上游限流（RESOURCE_LIMIT + isQueued:true）时，
// 非流式请求会被「先响应、后沉默」地挂住——连接不关也不出数据，最后由
// 中间层在 ~360s 处掐断，客户端只拿到无信息的 `aborted`。qoder/chat.js
// 的读空闲计时器（READ_IDLE_MS，每块数据重置）负责在沉默时主动断开。
//
// 四条不变量，改动时别破坏：
//   1. 先响应后沉默要在 READ_IDLE_MS 内断开（post 与 postStream 都要）。
//   2. 持续出帧的正常流不能被误杀——每块数据都重置计时器。
//   3. 全零字节仍由首字节超时兜底（READ_IDLE_MS 必须 > FIRST_BYTE_MS）。
//   4. READ_IDLE_MS=0 关闭，不给请求挂计时器。
//
// 手法：拦截 https.request（参照 verify-qwen-wallets-zero.js），用
// EventEmitter 造 req/res 按剧本喂帧。注意 chat.js 在模块加载时读一次
// 环境变量就定死，改配置必须删缓存重 require。
//
// 用法：node test/verify-qoder-read-idle.js
// ============================================================
const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');

const CHAT_PATH = require.resolve('../src/qoder/chat.js');
function loadChat(readIdle, firstByte, contentMs) {
  process.env.DUMATE_QODER_READ_IDLE_MS = String(readIdle);
  process.env.DUMATE_QODER_FIRST_BYTE_MS = String(firstByte);
  // 第 3 参不传则用模块默认（30s）——老用例不受影响
  if (contentMs !== undefined) process.env.DUMATE_QODER_CONTENT_MS = String(contentMs);
  else delete process.env.DUMATE_QODER_CONTENT_MS;
  delete require.cache[CHAT_PATH];
  return require('../src/qoder/chat.js');
}

const origRequest = https.request;
let script = null; // 当前用例的剧本：拿到 (req, res) 后怎么喂
https.request = function mockedRequest(opts, cb) {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {};
  // chat.js 的计时器到点会 req.destroy(err)，随后靠 req 的 'error' 收尾
  req.destroy = (err) => {
    if (req.__destroyed) return;
    req.__destroyed = true;
    setImmediate(() => req.emit('error', err || new Error('destroyed')));
  };
  setImmediate(() => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    cb(res);
    if (script) script(req, res);
  });
  return req;
};

const URL_STR = 'https://qoder-mock.invalid/api/chat/completions';
const FRAME = 'data: {"body":"{}"}\n\n';
// 真实内容帧（有 choices/delta）——用来验证「有内容后排队计时器必须被撤销」
const CONTENT_FRAME = 'data: {"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"hi\\"}}]}"}\n\n';
// 排队时上游先回的两种「假内容」（2026-10-27 实测）：
//   1. 限流信封；2. 首帧空 delta（正常流的第一帧也是这个形状）
const THROTTLE_FRAME = 'data: ' + JSON.stringify({
  body: JSON.stringify({ code: '403', message: JSON.stringify({ code: '10605', subCode: 'RESOURCE_LIMIT' }) }),
}) + '\n\n';
const EMPTY_DELTA_FRAME = 'data: ' + JSON.stringify({
  body: JSON.stringify({ choices: [{ delta: { content: '', reasoning_content: '', role: 'assistant' }, index: 0 }] }),
}) + '\n\n';

// chat.js 的计时器都 unref 了：mock 里没有别的句柄撑住事件循环，
// 不留一个 ref 的空转 interval，进程会在计时器触发前直接退出。
const keepAlive = setInterval(() => {}, 1000);

async function timed(p) {
  const t0 = Date.now();
  try {
    const v = await p;
    return { ok: true, ms: Date.now() - t0, v };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e };
  }
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

async function main() {
  console.log('Qoder 读空闲超时（qoder/chat.js）');

  const chat = loadChat(300, 200); // 读空闲 300ms，首字节 200ms（必须更短）

  await check('A. post：先响应后沉默，~300ms 内报 read idle 主动断开', async () => {
    script = (req, res) => { res.emit('data', Buffer.from(FRAME)); };
    const r = await timed(chat.post(URL_STR, '{}', {}));
    assert.strictEqual(r.ok, false, `应被读空闲计时器断开，实际正常返回: ${JSON.stringify(r.v)}`);
    assert.match(String(r.err && r.err.message), /read idle/, `错误串不对: ${r.err}`);
    assert.ok(r.ms >= 250 && r.ms <= 3000, `断开耗时 ${r.ms}ms 不在 [250, 3000]`);
  });

  await check('B. post：持续出帧的正常流不被误杀（每帧重置计时器）', async () => {
    script = (req, res) => {
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        res.emit('data', Buffer.from(`data: {"body":"{\\"n\\":${n}}"}\n\n`));
        if (n >= 8) { clearInterval(t); res.emit('end'); }
      }, 80);
    };
    const r = await timed(chat.post(URL_STR, '{}', {}));
    assert.strictEqual(r.ok, true, `正常流被误杀: ${r.err}`);
    assert.strictEqual(r.v.status, 200);
    const lines = String(r.v.raw).split('\n').filter((l) => l.startsWith('data:'));
    assert.strictEqual(lines.length, 8, `帧数不对: ${lines.length}`);
  });

  await check('C. post：全零字节仍由首字节超时兜底（200ms 先于 300ms）', async () => {
    script = () => {};
    const r = await timed(chat.post(URL_STR, '{}', {}));
    assert.strictEqual(r.ok, false, '应被首字节超时断开');
    assert.match(String(r.err && r.err.message), /first-byte timeout/, `错误串不对: ${r.err}`);
    assert.ok(r.ms >= 150 && r.ms <= 2000, `耗时 ${r.ms}ms 不在 [150, 2000]`);
  });

  await check('D. postStream：先响应后沉默，~300ms 内报 read idle', async () => {
    script = (req, res) => { res.emit('data', Buffer.from(FRAME)); };
    const r = await timed(chat.postStream(URL_STR, '{}', {}, () => {}));
    assert.strictEqual(r.ok, false, '应被读空闲计时器断开');
    assert.match(String(r.err && r.err.message), /read idle/, `错误串不对: ${r.err}`);
    assert.ok(r.ms >= 250 && r.ms <= 3000, `断开耗时 ${r.ms}ms 不在 [250, 3000]`);
  });

  const chat2 = loadChat(0, 5000); // READ_IDLE_MS=0 关闭
  await check('E. READ_IDLE_MS=0 关闭：沉默 400ms 不被掐，正常 end 收尾', async () => {
    script = (req, res) => {
      res.emit('data', Buffer.from(FRAME));
      setTimeout(() => res.emit('end'), 400);
    };
    const r = await timed(chat2.post(URL_STR, '{}', {}));
    assert.strictEqual(r.ok, true, `被误杀: ${r.err}`);
    assert.strictEqual(r.v.status, 200);
  });

  // ---- 排队 ack（2026-10-27 新增的「无内容」计时器）----
  //
  // 上游排队时**不是不出数据**：它很快回一帧空的 `data: {"body":"{}"}`，
  // 把首字节计时器清掉，然后沉默到读空闲的 120s。所以判据要放在「有没有
  // 真实内容」上，而不是「有没有字节」。
  const chat3 = loadChat(800, 200, 300); // 读空闲 800ms、首字节 200ms、无内容上限 300ms
  await check('F. postStream：只有空 ack 帧 → 由「无内容」计时器断开（不用等读空闲）', async () => {
    script = (req, res) => { res.emit('data', Buffer.from(FRAME)); };
    const r = await timed(chat3.postStream(URL_STR, '{}', {}, () => {}));
    assert.strictEqual(r.ok, false, '应被排队计时器断开');
    assert.match(String(r.err && r.err.message), /queued/, `错误串不对: ${r.err}`);
    assert.ok(r.ms >= 250 && r.ms <= 700, `断开耗时 ${r.ms}ms 不在 [250, 700]（应在 300ms 附近，而不是读空闲的 800ms）`);
  });

  await check('G. postStream：真实内容帧之后沉默 → 排队计时器被撤销，由读空闲收尾', async () => {
    script = (req, res) => { res.emit('data', Buffer.from(CONTENT_FRAME)); };
    const r = await timed(chat3.postStream(URL_STR, '{}', {}, () => {}));
    assert.strictEqual(r.ok, false, '应被读空闲断开');
    assert.match(String(r.err && r.err.message), /read idle/, `错误串不对（排队计时器误杀）: ${r.err}`);
    assert.ok(r.ms >= 700, `排队计时器不该提前掐（耗时 ${r.ms}ms）`);
  });

  await check('H. post：只有空 ack 帧 → 同样由「无内容」计时器断开', async () => {
    script = (req, res) => { res.emit('data', Buffer.from(FRAME)); };
    const r = await timed(chat3.post(URL_STR, '{}', {}));
    assert.strictEqual(r.ok, false, '应被排队计时器断开');
    assert.match(String(r.err && r.err.message), /queued/, `错误串不对: ${r.err}`);
  });

  await check('I. 限流信封（403/10605）不算内容 → 排队计时器照常断开', async () => {
    script = (req, res) => { res.emit('data', Buffer.from(THROTTLE_FRAME)); };
    const r = await timed(chat3.postStream(URL_STR, '{}', {}, () => {}));
    assert.strictEqual(r.ok, false, '应被排队计时器断开');
    assert.match(String(r.err && r.err.message), /queued/,
      `排队限流信封不该被当内容（那会让请求白等读空闲）: ${r.err}`);
  });

  await check('J. 首帧空 delta（正常流也这么开头）不算内容 → 仍由排队计时器断开', async () => {
    script = (req, res) => { res.emit('data', Buffer.from(EMPTY_DELTA_FRAME)); };
    const r = await timed(chat3.postStream(URL_STR, '{}', {}, () => {}));
    assert.strictEqual(r.ok, false, '应被排队计时器断开');
    assert.match(String(r.err && r.err.message), /queued/, `错误串不对: ${r.err}`);
  });

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
}

// 看门狗：任何用例挂住（计时器没按预期触发）就让测试显式失败而不是悬挂
const watchdog = setTimeout(() => {
  console.error('  ✗ 测试超时：有计时器没有按预期触发');
  process.exit(2);
}, 15000);
watchdog.unref();

main()
  .catch((e) => { fail++; console.error(e); })
  .finally(() => {
    clearInterval(keepAlive);
    https.request = origRequest;
    process.exit(fail ? 1 : 0);
  });
