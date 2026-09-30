// test/verify-qwen-daily-aggregate.js - 千问「每日额度」多账号合计的离线验证
//
// 不依赖网关/上游：把 qwenwork 管理路由挂上假的上游返回，验证**合计口径**。
//
// 背景（2026-09-30）：用户报「千问仪表盘每日额度显示不对，两个账号应该是
// 200 才对，今天都还没用」。
//
// 根因：`/api/admin/qwenwork/credits` 只读**主账号**（authStore.preferred()），
// 所以三个池子卡显示单个账号的 100；而同一页顶部「积分余额」卡读的是
// `/accounts` 的 summary.pointsTotal，**本来就是全账号合计** = 200。
// 同页两个数字口径不同，被读成「少算了一个账号」。
//
// 每日免费额度是**账号级**的：每个账号各有一份（各自 00:00 重置）。
// 所以池子卡的余额与分母都必须是全账号合计；而账号健康快照里每张卡
// 仍是单账号口径（问的是「这一个号今天还能用多少」）。
//
// 这个脚本把这几条不变量钉死：
//   1. /credits 的 daily 余额 = 各账号 daily 之和（不是主账号那一个）
//   2. /credits 的 dailyCap 分母 = 单账号上限 × 账号数（与分子同口径）
//   3. /credits.total === /accounts.summary.pointsTotal（同页两处必须相等）
//   4. dailyCapPerAccount 仍是单账号上限（每账号卡的分母）
//   5. 有账号查询失败时，failedAccounts 如实报出、合计只含成功的账号
//   6. 每个账号的 limit/freeUsed 按**各自**峰值算（不能拿 A 的峰值当 B 的）
const path = require('path');
const Module = require('module');

// 拦截 credits 模块的 fetchWallets：按账号返回预设余额，不打网络。
// 必须在上层 require 之前装好——路由是模块加载时 require 一次。
const creditsPath = require.resolve('../src/qwenwork/credits');
const realCredits = require(creditsPath);

const FAKE = {
  1: { daily: 100, monthly: 0, longterm: 0, limit: 100, peak: 100, calibrated: true, freeUsed: 0 },
  2: { daily: 100, monthly: 0, longterm: 0, limit: 100, peak: 100, calibrated: true, freeUsed: 0 },
};
let failIds = new Set(); // 这些账号返回查询失败

const origFetch = realCredits.fetchWallets;
realCredits.fetchWallets = async (opts = {}) => {
  const id = opts.account && opts.account.id;
  if (failIds.has(id)) {
    return { ok: false, error: `模拟失败: 账号 ${id}`, daily: null, monthly: null, longterm: null };
  }
  const f = FAKE[id];
  if (!f) return { ok: false, error: `未知账号 ${id}`, daily: null, monthly: null, longterm: null };
  return {
    ok: true, error: '',
    daily: f.daily, monthly: f.monthly, longterm: f.longterm,
    total: f.daily + f.monthly + f.longterm,
    paid: f.monthly + f.longterm,
    limit: f.limit, limitSource: f.calibrated ? 'observed' : 'config-lower-bound',
    peak: f.peak, calibrated: f.calibrated, freeUsed: f.calibrated ? f.freeUsed : null,
    expiring: [], expiringSoon: { count: 0, total: 0, wallets: [] },
    fetchedAt: Date.now(),
  };
};

// 同样拦掉 auth 模块：给两个账号（不走真实 data/ 文件）
const authPath = require.resolve('../src/qwenwork/auth');
const realAuth = require(authPath);
const ACCOUNTS = [
  { id: 1, uid: 'u1', nickname: '账号甲', enabled: true, preferred: true, accessToken: 't1', refreshToken: 'r1' },
  { id: 2, uid: 'u2', nickname: '账号乙', enabled: true, preferred: false, accessToken: 't2', refreshToken: 'r2' },
];
realAuth.list = () => ACCOUNTS.map((a) => ({ ...a }));
realAuth.get = (id) => ACCOUNTS.find((a) => String(a.id) === String(id)) || null;

const { routes, resetCache } = require('../src/admin/routes/qwenwork');

function fakeRes() {
  const o = { code: 0, body: null };
  o.writeHead = (c) => { o.code = c; };
  o.end = (b) => { o.body = b; };
  o.setHeader = () => {};
  return o;
}

async function call(p) {
  // 路由层有 15s 余额缓存，场景之间必须清掉，否则第二个场景读到第一个的结果
  resetCache();
  const r = routes.find((x) => x.path === p);
  const res = fakeRes();
  await r.handler({ req: { url: p }, res, body: null, params: [] });
  return JSON.parse(res.body);
}

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  console.log('== 两账号，各 100：合计应为 200 ==');
  const c = await call('/credits');
  const a = await call('/accounts');

  const daily = c.wallets.find((w) => w.id === 'daily').balance;
  const sumDaily = c.accounts.reduce((s, x) => s + x.daily, 0);

  check('池子卡 daily 是各账号之和', daily === sumDaily && daily === 200,
    `daily=${daily}, 各账号之和=${sumDaily}`);
  check('daily 不是单个账号的值', daily !== 100, `daily=${daily}`);
  check('accountCount 报出 2', c.accountCount === 2, String(c.accountCount));
  check('分母 dailyCap 是合计（单账号 × 账号数）', c.dailyCap === 200, String(c.dailyCap));
  check('单账号分母仍是 100', c.dailyCapPerAccount === 100, String(c.dailyCapPerAccount));

  // 同页两处口径必须相等——这正是用户看到的「对不上」
  check('/credits.total === /accounts.summary.pointsTotal',
    c.total === a.summary.pointsTotal,
    `${c.total} vs ${a.summary.pointsTotal}`);
  check('summary.pointsTotal 也是 200', a.summary.pointsTotal === 200, String(a.summary.pointsTotal));

  console.log('');
  console.log('== 每账号明细：limit/freeUsed 按各自峰值算 ==');
  check('accounts 明细给出 2 条', c.accounts.length === 2, String(c.accounts.length));
  check('每个账号的 limit 是各自的值',
    c.accounts.every((x) => x.limit === 100),
    JSON.stringify(c.accounts.map((x) => `${x.name}:${x.limit}`)));
  check('合计 limit = 各账号之和', c.limit === 200, String(c.limit));
  check('全部校准 → freeUsed 有数字（0）', c.freeUsed === 0, String(c.freeUsed));

  console.log('');
  console.log('== 有一个账号查不到时：合计只含成功的，并如实报失败数 ==');
  failIds = new Set([2]);
  const c2 = await call('/credits');
  check('failedAccounts 报出 1', c2.failedAccounts === 1, String(c2.failedAccounts));
  check('accountCount 降为 1', c2.accountCount === 1, String(c2.accountCount));
  check('daily 只含成功账号（100，不是 200）',
    c2.wallets.find((w) => w.id === 'daily').balance === 100,
    String(c2.wallets.find((w) => w.id === 'daily').balance));
  check('分母也随之降为 100（与分子同口径）', c2.dailyCap === 100, String(c2.dailyCap));
  check('仍 ok=true（部分成功不算整体失败）', c2.ok === true, String(c2.ok));
  check('retriedAccounts 默认 0（假上游没标 retried）', c2.retriedAccounts === 0, String(c2.retriedAccounts));

  console.log('');
  console.log('== 全部账号都查不到时：ok=false 并给出错误 ==');
  failIds = new Set([1, 2]);
  const c3 = await call('/credits');
  check('ok=false', c3.ok === false, String(c3.ok));
  check('有 error 文案', typeof c3.error === 'string' && c3.error.length > 0, c3.error);

  // 还原，避免影响同进程后续（脚本结束即退出，这里只为干净）
  failIds = new Set();
  realCredits.fetchWallets = origFetch;

  console.log('');
  if (failures) {
    console.log(`${failures} 项失败`);
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
})();
