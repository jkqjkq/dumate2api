// test/verify-qoder-throttle.js - Qoder 上游限流（排队）处置的离线验证
//
// ============================================================
// 为什么要有这个脚本
//
// 2026-10-23~27 实测：Qoder 上游限流会回
//   {"code":"10605","message":"{\"isQueued\":true,\"modelKey\":\"dfmodel\",
//    \"queueCount\":0,\"retryAfterSeconds\":30,\"serviceAvailable\":false,
//    \"subCode\":\"RESOURCE_LIMIT\"}"}
// 或者干脆「先响应后沉默」（qoder/chat.js 的 read idle 主动断开）。
//
// 旧实现把这**两种都当 breaker**（5xx/网络类熔断）处置，而熔断的退避是
// 30 分钟起步、每次翻倍。实测后果：两个账号各被限流 3 次 → 整个池被封
// 30 分钟，而用户侧看到的是「Qoder 用不了」——上游 30 秒后就恢复了。
//
// 四条不变量（改这里之前先读）：
//   1. 限流（RESOURCE_LIMIT / CALL_COUNT_LIMIT / isQueued / read idle）
//      **必须**归类成 soft，不能进 breaker——它带自己的重试时刻。
//   2. 上游给了 retryAfterSeconds / waitTime 就按它冷却（夹在 [1s, 封顶]），
//      不再套 5 分钟基数；**取不到才**回落基数。
//   3. 403 的限流必须**可换号**：排队粒度是 (账号, 模型)，换号能落到没排队的。
//   4. 失败全是限流时下游拿到 **429**（客户端会退避重试），不是 403/502/503。
//
// 手法：池用独立临时文件（DUMATE_POOL_STATE），qoder 的 auth/session/chat/credits
// 用模块导出覆盖打桩——不需要账号、不需要网络。
//
// 用法：node test/verify-qoder-throttle.js
// ============================================================
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 必须在 require pool 之前设：单例是模块加载时按这个路径建的
const TMP_STATE = path.join(os.tmpdir(), `dumate-qoder-throttle-${process.pid}.json`);
process.env.DUMATE_POOL_STATE = TMP_STATE;

const { classify, isThrottle, throttleRetryMs } = require('../src/upstream-errors');
const { createPool } = require('../src/pool');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}

// 实测抓包原文（内层 JSON 被当字符串塞进信封，引号是转义过的）
const THROTTLE_RESOURCE = 'qoder 403: {"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"dfmodel\\",\\"queueCount\\":0,\\"queueType\\":\\"p3\\",\\"retryAfterSeconds\\":30,\\"serviceAvailable\\":false,\\"subCode\\":\\"RESOURCE_LIMIT\\",\\"waitTime\\":30}","subCode":"RESOURCE_LIMIT"}';
const THROTTLE_CALLCOUNT = 'qoder 403: {"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"dfmodel\\",\\"queueCount\\":2410,\\"queueType\\":\\"p3\\",\\"retryAfterSeconds\\":30,\\"serviceAvailable\\":true,\\"subCode\\":\\"CALL_COUNT_LIMIT\\",\\"waitTime\\":66}","subCode":"CALL_COUNT_LIMIT"}';
const READ_IDLE = 'qoder upstream read idle (120000ms)';
const MODEL_GONE = 'qoder 403: {"code":"403","message":"Model is not available for this user"}';

console.log('== 1. 限流识别 ==');
check('RESOURCE_LIMIT 认得出', () => assert.ok(isThrottle(THROTTLE_RESOURCE)));
check('CALL_COUNT_LIMIT 认得出', () => assert.ok(isThrottle(THROTTLE_CALLCOUNT)));
check('read idle 认得出（排队挂起的另一种形态）', () => assert.ok(isThrottle(READ_IDLE)));
check('普通模型不可用不是限流', () => assert.ok(!isThrottle(MODEL_GONE)));
check('取 retryAfterSeconds → 30000ms', () => assert.strictEqual(throttleRetryMs(THROTTLE_RESOURCE), 30000));
check('无 retryAfterSeconds 时优先 waitTime → 66000ms', () => assert.strictEqual(throttleRetryMs(THROTTLE_CALLCOUNT), 66000));
check('取不到时长返回 null（不编默认值）', () => assert.strictEqual(throttleRetryMs(READ_IDLE), null));

console.log('');
console.log('== 2. classify：限流进 soft，不进 breaker ==');
check('403 + RESOURCE_LIMIT → soft 且带 retryAfterMs', () => {
  const c = classify({ status: 403, message: THROTTLE_RESOURCE, model: 'dfmodel' });
  assert.strictEqual(c.kind, 'soft');
  assert.strictEqual(c.retryAfterMs, 30000);
});
check('502 + RESOURCE_LIMIT → soft（状态码不改变判据）', () => {
  assert.strictEqual(classify({ status: 502, message: THROTTLE_RESOURCE, model: 'dfmodel' }).kind, 'soft');
});
check('status=0 + read idle → soft', () => {
  assert.strictEqual(classify({ status: 0, message: READ_IDLE }).kind, 'soft');
});
check('排队挂起用短冷却（5s），不套 5 分钟基数', () => {
  // 上游没给时长时，read idle / queued 都是「这一条被排掉了」，与账号健康无关
  for (const m of [READ_IDLE, 'qoder upstream queued (no content in 30000ms)']) {
    const c = classify({ status: 0, message: m });
    assert.strictEqual(c.kind, 'soft');
    assert.strictEqual(c.retryAfterMs, 5000, m);
  }
});
check('403 模型不可用仍然是 model（没被限流规则吃掉）', () => {
  assert.strictEqual(classify({ status: 403, message: MODEL_GONE, model: 'dfmodel' }).kind, 'model');
});
check('纯 403（既非限流也非模型）仍是 breaker', () => {
  assert.strictEqual(classify({ status: 403, message: 'qoder 403: forbidden' }).kind, 'breaker');
});
check('402 仍是 hard', () => {
  assert.strictEqual(classify({ status: 402, message: 'insufficient balance' }).kind, 'hard');
});
check('限流信号在 200 字之后也能识别（用完整串判）', () => {
  const long = 'qoder 403: ' + 'x'.repeat(220) + ' {"subCode":"RESOURCE_LIMIT","retryAfterSeconds":30}';
  assert.strictEqual(classify({ status: 403, message: long }).kind, 'soft');
  assert.strictEqual(classify({ status: 403, message: long }).retryAfterMs, 30000);
});

console.log('');
console.log('== 3. 池：限流不再放大成 30 分钟封禁 ==');
check('连续 3 次限流 → 软冷却 30s（不是 30min 熔断）', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  const cls = classify({ status: 403, message: THROTTLE_RESOURCE, model: 'dfmodel' });
  for (let i = 0; i < 3; i++) pool.noteError('qoder:1', cls);
  const st = pool.status('qoder:1');
  assert.strictEqual(st.cool_kind, 'soft', '应为软冷却，实际 ' + st.cool_kind);
  assert.strictEqual(st.breaker_fails, 0);
  assert.ok(st.cool_remaining_s <= 30, '冷却应 ≤30s，实际 ' + st.cool_remaining_s);
});
check('上游说的重试时刻到了就能重新选号', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  const cls = classify({ status: 403, message: THROTTLE_RESOURCE });
  pool.noteError('qoder:1', cls);
  assert.strictEqual(pool.pick(['qoder:1'], {}), null, '冷却中不该被选中');
  now += 30_000;
  assert.strictEqual(pool.pick(['qoder:1'], {}), 'qoder:1', '30s 后应恢复');
});
check('没有 retryAfterMs 时才回落基数（5 分钟）', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  pool.noteError('qoder:1', classify({ status: 429, message: 'too many requests' }));
  const st = pool.status('qoder:1');
  assert.strictEqual(st.cool_kind, 'soft');
  assert.ok(st.cool_remaining_s >= 290, '应回落到 5 分钟基数，实际 ' + st.cool_remaining_s);
});
check('冷却中再次限流不延长（防堆厚）', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  const cls = classify({ status: 403, message: THROTTLE_RESOURCE });
  pool.noteError('qoder:1', cls);
  const until1 = pool.status('qoder:1').until;
  now += 5_000;
  pool.noteError('qoder:1', cls);
  assert.strictEqual(pool.status('qoder:1').until, until1, '冷却时长不该被叠加');
});
check('异常的 retryAfterMs 被夹进 [1s, 封顶]', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  pool.noteError('a:1', { kind: 'soft', message: 'x', retryAfterMs: 1 });     // 太小
  assert.ok(pool.status('a:1').cool_remaining_s >= 1);
  const pool2 = createPool({ file: null, now: () => now });
  pool2.noteError('a:1', { kind: 'soft', message: 'x', retryAfterMs: 99 * 3600 * 1000 }); // 太大
  assert.ok(pool2.status('a:1').cool_remaining_s <= 2 * 3600, '应被 softMaxMs 封顶');
});

console.log('');
console.log('== 4. 通道层：换号 + 下游拿到 429 ==');

// 池单例已在 DUMATE_POOL_STATE 的临时文件上，不会碰真实 data/
const authStore = require('../src/qoder/auth');
const session = require('../src/qoder/session');
const chat = require('../src/qoder/chat');
const credits = require('../src/qoder/credits');
const channelPool = require('../src/channel-pool');

const ACCOUNTS = [
  { id: 901, nickname: 'acct-a', region: 'cn', uid: 'ua', accessToken: 'ta', refreshToken: 'ra', enabled: true, preferred: true },
  { id: 902, nickname: 'acct-b', region: 'cn', uid: 'ub', accessToken: 'tb', refreshToken: 'rb', enabled: true, preferred: false },
];
const MODELS = [{ key: 'gfmodel', name: 'GLM-5.3-Flash', maxInputTokens: 100000 }];

authStore.findUsable = () => ACCOUNTS;
authStore.preferred = () => ACCOUNTS[0];
authStore.patch = () => true;               // 不写真实账号文件
session.ensureAccount = async (store, acc) => acc;
session.cachedModels = () => MODELS;
session.fetchModels = async () => ({ ok: true, error: '', models: MODELS });
credits.capture = () => {};                 // 不写真实积分账本

/** 让 postStream 按「当前账号的 accessToken → 剧本」返回：'throttle' | 'readidle' | 'ok'
 *  剧本可以是数组，按该账号的第 N 次调用依次取（用于验证「重试同一账号」）。 */
let scripts = {};
let currentToken = '';
let callsByToken = {};
chat.postStream = async (url, body, headers, onChunk) => {
  const n = (callsByToken[currentToken] = (callsByToken[currentToken] || 0) + 1);
  let plan = scripts[currentToken] || 'ok';
  if (Array.isArray(plan)) plan = plan[n - 1] || plan[plan.length - 1] || 'ok';
  if (plan === 'throttle') {
    const err = new Error(THROTTLE_RESOURCE);
    err.statusCode = 403;
    throw err;
  }
  if (plan === 'readidle') {
    const err = new Error(READ_IDLE);
    err.statusCode = 0;
    throw err;
  }
  onChunk(JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }] }));
  onChunk(JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { credits: 0.1 } }));
  onChunk('[DONE]');
  return { status: 200, headers: {}, raw: '' };
};

function resetCase(plan) {
  channelPool._stickyClear();
  callsByToken = {};
  scripts = plan;
}

(async () => {
  // runOnce 内部会经 ensureAccount 取账号——用 accessToken 标记「这一轮是谁」
  session.ensureAccount = async (store, acc) => { currentToken = acc.accessToken; return acc; };

  const payload = { model: 'gfmodel', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };

  await checkAsync('账号 A 被限流 → 自动换到 B 并成功', async () => {
    channelPool._stickyClear();
    scripts = { ta: 'throttle', tb: 'ok' };
    const chunks = [];
    const r = await require('../src/qoder').send(payload, (c) => chunks.push(c), { sessionKey: 'case-a' });
    assert.strictEqual(r.status, 200);
    assert.ok(chunks.some((c) => c.includes('pong')), '应从 B 拿到正文');
    // A 进软冷却（30s），B 健康
    const stA = require('../src/pool').pool.status('qoder:901');
    assert.strictEqual(stA.cool_kind, 'soft');
    assert.ok(stA.cool_remaining_s <= 30, 'A 的冷却应是上游给的 30s，实际 ' + stA.cool_remaining_s);
    require('../src/pool').pool.revive('qoder:901');
  });

  await checkAsync('两个账号都被限流 → 下游 429（不是 403/502）', async () => {
    channelPool._stickyClear();
    scripts = { ta: 'throttle', tb: 'throttle' };
    let err = null;
    try { await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-b' }); }
    catch (e) { err = e; }
    assert.ok(err, '应该抛错');
    assert.strictEqual(err.statusCode, 429, '实际 ' + err.statusCode + ' / ' + err.message);
    assert.ok(err.throttled === true);
    require('../src/pool').pool.revive('qoder:901');
    require('../src/pool').pool.revive('qoder:902');
  });

  await checkAsync('两账号都在限流冷却里 → 立刻回 429 而不是 503', async () => {
    channelPool._stickyClear();
    const { pool } = require('../src/pool');
    const cls = classify({ status: 403, message: THROTTLE_RESOURCE });
    pool.noteError('qoder:901', cls);
    pool.noteError('qoder:902', cls);
    let err = null;
    try { await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-c' }); }
    catch (e) { err = e; }
    assert.ok(err, '应该抛错');
    assert.strictEqual(err.statusCode, 429, '实际 ' + err.statusCode + ' / ' + err.message);
    assert.ok(/限流/.test(err.message), '错误文案应说明是限流：' + err.message);
    pool.revive('qoder:901');
    pool.revive('qoder:902');
  });

  await checkAsync('读空闲（排队挂起）也换号并成功', async () => {
    channelPool._stickyClear();
    scripts = { ta: 'readidle', tb: 'ok' };
    const r = await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-d' });
    assert.strictEqual(r.status, 200);
    const { pool } = require('../src/pool');
    const stA = pool.status('qoder:901');
    assert.strictEqual(stA.cool_kind, 'soft', 'read idle 应进软冷却');
    assert.strictEqual(stA.breaker_fails, 0, 'read idle 不该累计熔断');
    pool.revive('qoder:901');
  });

  await checkAsync('排队挂起后等掉短冷却、重试同一账号 → 成功（不必两轮都无法命中）', async () => {
    // 上游排队是**请求级随机**的（实测同一账号挂起一次后紧接着 5 次全成功），
    // 所以「A 挂起 → B 挂起 → 等 5 秒 → 再打 A」应当能过。
    resetCase({ ta: ['readidle', 'ok'], tb: ['readidle'] });
    const t0 = Date.now();
    const r = await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-e' });
    const spent = Date.now() - t0;
    assert.strictEqual(r.status, 200);
    assert.ok(spent >= 4000, '应先等掉排队冷却（约 5s），实际 ' + spent + 'ms');
    const { pool } = require('../src/pool');
    pool.revive('qoder:901');
    pool.revive('qoder:902');
  });

  session.ensureAccount = async (store, acc) => acc;

  // 清理临时池文件
  try { require('../src/pool').pool.close(); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(TMP_STATE); } catch (e) { /* 不存在 */ }

  console.log('');
  if (failures) { console.log(`✗ ${failures} 项失败`); process.exit(1); }
  console.log('✓ 全部通过');
})();
