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
function loadChat(readIdle, firstByte) {
  process.env.DUMATE_QODER_READ_IDLE_MS = String(readIdle);
  process.env.DUMATE_QODER_FIRST_BYTE_MS = String(firstByte);
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
