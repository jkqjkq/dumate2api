// test/verify-qwen-wallets-zero.js - 「三池全 0」响应的离线验证
//
// 不依赖网关/上游：直接替换 https.request，喂入预设的响应体。
//
// 背景（2026-09-30）：用户问「千问的每日免费积分是不是每天得使用一下才刷新，
// 所以出现了 0 的情况」。
//
// 结论分两半：
//
// 1. **「必须使用才刷新」不成立**。实测账号 2 当天零请求，昨日收尾 4.9657，
//    次日读到满额 100；重置时刻是 wallet 的 valid_to（每天 00:00 +08:00）。
//
// 2. 但用户看到的那个「0」是**真实存在**的，成因不是「没刷新」，而是
//    `/user/wallets` 偶尔返回「三池全 0 + active_wallets 空」的**瞬时响应**。
//    决定性证据：同一时刻打两个接口，wallets 报全 0 而 account-context 的
//    quota.remaining 报 100——两者矛盾，说明那次是读失败而非余额归零。
//
// 但**不能一律把全 0 当成读失败**：真·额度耗尽时三池确实都是 0，那时显示 0
// 是正确的。所以用**重试一次**来区分：
//   - 瞬时抖动：重试即恢复 → 用重试的结果
//   - 真实归零：重试仍是 0 → 如实上报 0（并标 retried，便于排查）
//
// 早先的实现把瞬时 0 直接当成 ok=true 的余额 0 返回 → 界面显示「每日额度 0」
// → 被读成「今天用光了」。这就是用户报的现象。
const https = require('https');

// 拦截 https.request：按队列依次返回预设响应体，不打网络
const origRequest = https.request;
let RESPONSES = []; // 每次请求消费一个（字符串或函数）
let CALLS = 0;
https.request = function (opts, cb) {
  const { EventEmitter } = require('events');
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  const req = new EventEmitter();
  req.end = () => {
    setImmediate(() => {
      CALLS++;
      const spec = RESPONSES.length > 1 ? RESPONSES.shift() : RESPONSES[0];
      const body = typeof spec === 'function' ? spec() : spec;
      cb(res);
      res.emit('data', Buffer.from(body, 'utf8'));
      res.emit('end');
    });
  };
  req.destroy = () => {};
  req.write = () => {};
  req.setTimeout = () => {};
  return req;
};

const credits = require('../src/qwenwork/credits');

/** 正常响应：指定三池余额，active_wallets 按余额决定 */
function bodyOk(daily, monthly = 0, longterm = 0) {
  const has = daily > 0 || monthly > 0 || longterm > 0;
  return JSON.stringify({
    code: 'ok',
    data: {
      active_wallets: {
        wallets: has ? [{ balance: daily, valid_to: '2026-10-01T00:00:00+08:00' }] : [],
        total: has ? 1 : 0, page_size: 20, page_number: 1,
      },
      daily_credits: { total_balance: daily },
      monthly_credits: { total_balance: monthly },
      longterm_credits: { total_balance: longterm },
      expiring_soon: { count: 0, total_balance: 0, wallets: [] },
    },
  });
}

/** 瞬时异常响应：三池全 0 + active_wallets 空 */
const BODY_ZERO = bodyOk(0, 0, 0);

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

let ACC_N = 0;
/** 每个用例用新账号 id，避开缓存串扰 */
function newAcc() { ACC_N++; return { id: 9000 + ACC_N, accessToken: `tok-${ACC_N}` }; }

(async () => {
  console.log('== 正常响应：照常返回 ==');
  let acc = newAcc();
  RESPONSES = [bodyOk(100)];
  let w = await credits.fetchWallets({ account: acc, force: true });
  check('ok=true', w.ok === true, String(w.ok));
  check('daily=100', w.daily === 100, String(w.daily));
  check('不标 retried', !w.retried, String(w.retried));

  console.log('');
  console.log('== 瞬时全 0：重试一次，恢复成真实值 ==');
  acc = newAcc();
  CALLS = 0;
  // 第一次全 0（抖动），第二次 100
  RESPONSES = [BODY_ZERO, bodyOk(100)];
  w = await credits.fetchWallets({ account: acc, force: true });
  check('打了 2 次（触发了一次重试）', CALLS === 2, `CALLS=${CALLS}`);
  check('ok=true', w.ok === true, String(w.ok));
  check('daily=100（用重试的结果，不是 0）', w.daily === 100, String(w.daily));
  check('不标 retried（已恢复，不算异常）', !w.retried, String(w.retried));

  console.log('');
  console.log('== 真实归零：重试仍是 0，如实上报（不掩盖） ==');
  acc = newAcc();
  CALLS = 0;
  RESPONSES = [BODY_ZERO]; // 每次都返回全 0
  w = await credits.fetchWallets({ account: acc, force: true });
  check('打了 2 次（也重试了）', CALLS === 2, `CALLS=${CALLS}`);
  check('ok=true（真实归零不是错误）', w.ok === true, String(w.ok));
  check('daily 如实为 0', w.daily === 0, String(w.daily));
  check('标 retried 便于排查', w.retried === true, String(w.retried));

  console.log('');
  console.log('== 免费扣完转付费：daily=0 但付费池有余额，不该触发重试 ==');
  acc = newAcc();
  CALLS = 0;
  RESPONSES = [bodyOk(0, 0, 250)];
  w = await credits.fetchWallets({ account: acc, force: true });
  check('只打 1 次（不触发重试）', CALLS === 1, `CALLS=${CALLS}`);
  check('ok=true', w.ok === true, String(w.ok));
  check('daily=0 如实', w.daily === 0, String(w.daily));
  check('longterm=250', w.longterm === 250, String(w.longterm));
  check('不标 retried', !w.retried, String(w.retried));

  console.log('');
  console.log('== 全 0 但 active_wallets 非空：不算可疑，不重试 ==');
  acc = newAcc();
  CALLS = 0;
  RESPONSES = [JSON.stringify({
    code: 'ok',
    data: {
      active_wallets: { wallets: [{ balance: 0, valid_to: '2026-10-01T00:00:00+08:00' }], total: 1 },
      daily_credits: { total_balance: 0 },
      monthly_credits: { total_balance: 0 },
      longterm_credits: { total_balance: 0 },
    },
  })];
  w = await credits.fetchWallets({ account: acc, force: true });
  check('只打 1 次', CALLS === 1, `CALLS=${CALLS}`);
  check('ok=true', w.ok === true, String(w.ok));

  console.log('');
  console.log('== 非 200：如实报错 ==');
  acc = newAcc();
  RESPONSES = [JSON.stringify({ code: 'invalid-credential' })];
  // 让状态码为 401
  const savedStatus = https.request;
  https.request = function (opts, cb) {
    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    res.statusCode = 401;
    res.headers = {};
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      cb(res);
      res.emit('data', Buffer.from('{"code":"invalid-credential"}', 'utf8'));
      res.emit('end');
    });
    req.destroy = () => {}; req.write = () => {}; req.setTimeout = () => {};
    return req;
  };
  w = await credits.fetchWallets({ account: acc, force: true });
  check('ok=false', w.ok === false, String(w.ok));
  check('daily 是 null（不是 0）', w.daily === null, String(w.daily));
  check('error 带状态码', /401/.test(w.error || ''), w.error);
  https.request = savedStatus;

  https.request = origRequest;

  console.log('');
  if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
  console.log('全部通过');
  process.exit(0);
})();
