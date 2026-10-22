// test/verify-qoder-error-surface.js - Qoder 上游失败必须**报错**，不能静默空回答
//
// 2026-10-22 修的两个静默失败形态（都表现为「HTTP 200 + 空回答」，不报错）：
//   1. provider 层失败时上游发的是 `{"code":"provider_error","message":"All backends failed"}`
//      —— 字符串 code、首字母小写，旧判据 /^[A-Z]/ 漏掉它，整帧被当正常数据转发。
//   2. 上游 4xx/5xx 时 body 往往不是 SSE（没有 `data:` 行），流式路径一帧都收不到，
//      旧实现当成功返回。
//
// 离线：打桩 chat.postStream / auth / session / credits，不需要账号与网络。
const assert = require('assert');
const auth = require('../src/qoder/auth');
const session = require('../src/qoder/session');
const chat = require('../src/qoder/chat');
const credits = require('../src/qoder/credits');
const qoder = require('../src/qoder/index');

const ACCOUNT = {
  id: 9901, uid: 'uid-test', nickname: '测试账号', region: 'cn',
  accessToken: 'at', refreshToken: 'rt',
  machineId: 'mid', machineToken: 'mtok', machineType: '5',
  enabled: true,
};
const MODELS = [{ key: 'gfmodel', name: 'GLM-5.3-Flash', maxInputTokens: 1000000 }];

// ---- 打桩：只替换边界，签名与 body 构造仍走真实实现 ----
auth.findUsable = () => [ACCOUNT];
auth.preferred = () => ACCOUNT;
auth.patch = () => {};
session.ensureAccount = async () => ACCOUNT;
session.cachedModels = () => MODELS;
session.fetchModels = async () => ({ ok: true, models: MODELS });
credits.capture = () => {};

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}

const PAYLOAD = { model: 'qoder/GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }] };

async function collect(fn) {
  const chunks = [];
  let error = null;
  try { await fn((c) => chunks.push(c)); }
  catch (e) { error = e; }
  return { chunks, error };
}

(async () => {
  console.log('== provider_error 帧 ==');
  chat.postStream = async (url, body, headers, onChunk) => {
    onChunk(JSON.stringify({
      code: 'provider_error', message: 'All backends failed',
      request_id: 'x', type: 'provider_error',
    }));
    onChunk('[DONE]');
    return { status: 200, headers: {}, raw: '' };
  };
  let r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('provider_error 必须 reject', () => assert.ok(r.error, '应抛出错误，实际成功返回'));
  check('错误里带上游原因', () => assert.ok(/provider_error|All backends failed/.test(r.error.message), r.error && r.error.message));
  check('错误帧不转发给客户端', () => assert.strictEqual(r.chunks.length, 0, JSON.stringify(r.chunks)));

  console.log('');
  console.log('== HTTP 429 + 非 SSE 错误体 ==');
  chat.postStream = async () => ({
    status: 429, headers: {},
    raw: '{"code":429,"message":"Too many requests"}',
  });
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('HTTP 429 必须 reject', () => assert.ok(r.error, '应抛出错误，实际成功返回'));
  check('状态码透传 429', () => assert.strictEqual(r.error.statusCode, 429, String(r.error && r.error.statusCode)));
  check('message 带上游原文', () => assert.ok(/Too many requests/.test(r.error.message), r.error && r.error.message));

  console.log('');
  console.log('== 200 + 纯 provider_error 体（没有 data: 行）==');
  chat.postStream = async () => ({
    status: 200, headers: {},
    raw: '{"code":"provider_error","message":"All backends failed","type":"provider_error"}',
  });
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('200 错误体也要 reject', () => assert.ok(r.error, '应抛出错误，实际成功返回'));

  console.log('');
  console.log('== 正常流不受影响 ==');
  chat.postStream = async (url, body, headers, onChunk) => {
    onChunk(JSON.stringify({ choices: [{ delta: { content: '好' } }] }));
    onChunk('[DONE]');
    return { status: 200, headers: {}, raw: '' };
  };
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('正常流 resolve', () => assert.strictEqual(r.error, null, r.error && r.error.message));
  check('正文已转发', () => assert.ok(r.chunks.some((c) => c.includes('"content":"好"')), JSON.stringify(r.chunks)));
  check('补发 [DONE]', () => assert.strictEqual(r.chunks[r.chunks.length - 1], '[DONE]'));

  console.log('');
  console.log('== 模型名解析（缓存为空时补拉）==');
  // 缓存为空 + 名字是显示名 → 补拉后解析成内部 key
  let fetched = 0;
  session.cachedModels = () => null;
  session.fetchModels = async () => { fetched++; return { ok: true, models: MODELS }; };
  // postStream 收到的是 cosy.encode 后的 body（不是 JSON），所以从 buildBody
  // 的入参抓模型 key —— 那才是「解析结果」真正生效的地方。
  let seenKey = null;
  const realBuildBody = chat.buildBody;
  chat.buildBody = (key, payload, opts) => { seenKey = key; return realBuildBody(key, payload, opts); };
  chat.postStream = async () => ({ status: 200, headers: {}, raw: '' });
  await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('缓存为空时补拉模型表', () => assert.strictEqual(fetched, 1, 'fetched=' + fetched));
  check('显示名解析成内部 key', () => assert.strictEqual(seenKey, 'gfmodel', String(seenKey)));

  // 埋点要能看到「实际发给上游的 key」，否则这类解析失败在日志里不可见
  let gotModel = null;
  await qoder.send(PAYLOAD, () => {}, { onModel: (k) => { gotModel = k; } }).catch(() => {});
  check('onModel 上报实际 key', () => assert.strictEqual(gotModel, 'gfmodel', String(gotModel)));

  console.log('');
  if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
  console.log('全部通过');
  process.exit(0);
})();
