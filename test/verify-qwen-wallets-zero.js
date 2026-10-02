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

// 拦截 https.request：按队列依次返回预设响应体，不打网络。
// 两个上游要分开：/user/wallets（qwenwork.cn）与 account-context（gateway）。
// 交叉验证逻辑会在 wallets 谎报 0 时去打 account-context，所以 mock 必须按
// path 路由，否则两边会互相消费对方的预设响应。
const origRequest = https.request;
let RESPONSES = [];       // /user/wallets 的响应队列（字符串或函数）
let CONTEXT_RESPONSES = []; // account-context 的响应队列；空 = 无（模拟取不到）
let CALLS = 0;
let CTX_CALLS = 0;
https.request = function (opts, cb) {
  const { EventEmitter } = require('events');
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  const isCtx = /account-context/.test(opts.path || '');
  const req = new EventEmitter();
  req.end = () => {
    setImmediate(() => {
      let body;
      if (isCtx) {
        CTX_CALLS++;
        if (!CONTEXT_RESPONSES.length) { res.statusCode = 404; body = '404'; }
        else {
          const spec = CONTEXT_RESPONSES.length > 1 ? CONTEXT_RESPONSES.shift() : CONTEXT_RESPONSES[0];
          body = typeof spec === 'function' ? spec() : spec;
        }
      } else {
        CALLS++;
        const spec = RESPONSES.length > 1 ? RESPONSES.shift() : RESPONSES[0];
        body = typeof spec === 'function' ? spec() : spec;
      }
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

/** account-context 响应：给出权威 quota.remaining（= 三池之和） */
function bodyCtx(remaining) {
  return JSON.stringify({
    code: 'ok',
    data: { quota: { total: null, used: null, remaining, exceeded: false } },
  });
}

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
  RESPONSES = [bodyOk(100)]; CONTEXT_RESPONSES = [];
  let w = await credits.fetchWallets({ account: acc, force: true });
  check('ok=true', w.ok === true, String(w.ok));
  check('daily=100', w.daily === 100, String(w.daily));
  check('不标 retried', !w.retried, String(w.retried));

  console.log('');
  console.log('== 瞬时全 0：重试一次，恢复成真实值 ==');
  acc = newAcc();
  CALLS = 0;
  // 第一次全 0（抖动），第二次 100
  RESPONSES = [BODY_ZERO, bodyOk(100)]; CONTEXT_RESPONSES = [];
  w = await credits.fetchWallets({ account: acc, force: true });
  check('打了 2 次（触发了一次重试）', CALLS === 2, `CALLS=${CALLS}`);
  check('ok=true', w.ok === true, String(w.ok));
  check('daily=100（用重试的结果，不是 0）', w.daily === 100, String(w.daily));
  check('不标 retried（已恢复，不算异常）', !w.retried, String(w.retried));

  console.log('');
  console.log('== 重试仍是全 0 且 account-context 取不到：如实上报 0（不编数字） ==');
  acc = newAcc();
  CALLS = 0; CTX_CALLS = 0;
  RESPONSES = [BODY_ZERO]; // 每次都返回全 0
  CONTEXT_RESPONSES = []; // account-context 404（取不到）
  w = await credits.fetchWallets({ account: acc, force: true });
  check('打了 2 次 wallets（重试了）', CALLS === 2, `CALLS=${CALLS}`);
  check('打过 1 次 account-context（做了交叉验证）', CTX_CALLS === 1, `CTX=${CTX_CALLS}`);
  check('ok=true（无法判定不是错误）', w.ok === true, String(w.ok));
  check('daily 如实为 0', w.daily === 0, String(w.daily));
  check('标 retried 便于排查', w.retried === true, String(w.retried));
  check('不标 dailyCorrected（没校正出值）', !w.dailyCorrected, String(w.dailyCorrected));

  console.log('');
  console.log('== wallets 谎报 0 但 account-context 给出权威值：交叉验证还原 daily ==');
  // 这是 2026-10-02 用户报的场景：免费额度其实已刷新（remaining=100），
  // wallets 却持续报 daily=0。修法：daily = remaining − monthly − longterm。
  acc = newAcc();
  CALLS = 0; CTX_CALLS = 0;
  RESPONSES = [BODY_ZERO]; // wallets 一直是全 0
  CONTEXT_RESPONSES = [bodyCtx(100)]; // 权威 remaining=100
  w = await credits.fetchWallets({ account: acc, force: true });
  check('打了 2 次 wallets', CALLS === 2, `CALLS=${CALLS}`);
  check('ok=true', w.ok === true, String(w.ok));
  check('daily=100（校正为真实值，不是 0）', w.daily === 100, String(w.daily));
  check('标 dailyCorrected', w.dailyCorrected === true, String(w.dailyCorrected));
  check('不标 retried（已校正，不是异常）', !w.retried, String(w.retried));
  check('freeUsed 不再被误算成「已用 100」', w.freeUsed !== 100, String(w.freeUsed));

  console.log('');
  console.log('== 付费池为负 + 免费已刷新：remaining=95.1778 → daily=100 ==');
  // 实测账号 2：longterm = −4.8222，remaining = 95.1778，还原 daily = 100。
  acc = newAcc();
  CALLS = 0; CTX_CALLS = 0;
  RESPONSES = [JSON.stringify({
    code: 'ok',
    data: {
      active_wallets: { wallets: [], total: 0, page_size: 20, page_number: 1 },
      daily_credits: { total_balance: 0 },
      monthly_credits: { total_balance: 0 },
      longterm_credits: { total_balance: -4.8222 },
      expiring_soon: { count: 0, total_balance: 0, wallets: [] },
    },
  })];
  CONTEXT_RESPONSES = [bodyCtx(95.1778)];
  w = await credits.fetchWallets({ account: acc, force: true });
  check('daily=100（remaining − (−4.8222)）', w.daily === 100, String(w.daily));
  check('longterm 如实为 −4.8222', w.longterm === -4.8222, String(w.longterm));
  check('标 dailyCorrected', w.dailyCorrected === true, String(w.dailyCorrected));

  console.log('');
  console.log('== 真·额度耗尽：remaining 也约等于 0，不误判成「刷新了」 ==');
  // 三池真耗尽时 account-context 的 remaining 也该是 0（或 ≤ 付费池）。
  // 此时 remaining − paid 不 > 0.005，不触发校正，如实报 0。
  acc = newAcc();
  CALLS = 0; CTX_CALLS = 0;
  RESPONSES = [BODY_ZERO];
  CONTEXT_RESPONSES = [bodyCtx(0)];
  w = await credits.fetchWallets({ account: acc, force: true });
  check('daily 如实为 0（未误判）', w.daily === 0, String(w.daily));
  check('不标 dailyCorrected', !w.dailyCorrected, String(w.dailyCorrected));
  check('标 retried（无法区分真耗尽/持续坏读）', w.retried === true, String(w.retried));

  console.log('');
  console.log('== 免费扣完转付费：daily=0 但付费池有余额，不该触发重试 ==');
  acc = newAcc();
  CALLS = 0;
  RESPONSES = [bodyOk(0, 0, 250)]; CONTEXT_RESPONSES = [];
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
