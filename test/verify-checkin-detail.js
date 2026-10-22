// test/verify-checkin-detail.js - 签到详情（按月/按年）的合并口径与覆盖范围
//
// 离线：打桩账号 / 操作流水 / 上游 sign_in_days / Qoder 领取账本，
// 账本目录用临时目录，不碰真实数据、不联网。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-checkin-'));

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  const m = new Module(p, null);
  m.filename = p;
  m.loaded = true;
  m.exports = exports;
  require.cache[p] = m;
}

const at = (y, mo, d, h = 9) => new Date(y, mo - 1, d, h, 0, 0).getTime();

// ---- 搭子：两个账号，一个上游可用、一个查询失败 ----
const ACCOUNTS = [
  { id: 1, name: '张三', enabled: true, cookie: 'c1', checkin: { last_at: at(2026, 10, 20) } },
  { id: 2, name: '账号 2', enabled: true, cookie: 'c2', nickname: '李四', checkin: {} },
];
stub('src/accounts', {
  load: () => ({ accounts: ACCOUNTS }),
  displayName: (a) => {
    const n = String(a.name || '').trim();
    if (n && !/^账号\s*\d+$/.test(n)) return n;
    return String(a.nickname || '').trim() || n || `账号 ${a.id}`;
  },
  getRaw: (id) => ACCOUNTS.find((a) => a.id === Number(id)) || null,
});
stub('src/records', {
  read: ({ type }) => ({
    rows: type === 'checkin' ? [
      { ts: at(2026, 9, 22), type: 'checkin', account_id: 1, ok: true, points_delta: 500 },
      { ts: at(2026, 9, 23), type: 'checkin', account_id: 1, ok: false },
    ] : [],
  }),
});
stub('src/dumate-web', {
  api: {
    loginBonusInfo: async (cookie) => (cookie === 'c1'
      ? { ok: true, sign_in_days: ['2026-10-01', '2026-10-02'], has_issued: true, total_times: 5 }
      : { ok: false, error: 'cookie expired' }),
  },
});
// ---- TRAE / Qoder 账号与领取账本 ----
stub('src/traework/auth', {
  load: () => ({ accounts: [{ id: 7, uid: 'tw', nickname: 'TRAE 号', enabled: true, lastCheckin: at(2026, 10, 21) }] }),
});
stub('src/qoder/auth', {
  load: () => ({ accounts: [{ id: 9, uid: 'qd', nickname: 'Qoder 号', enabled: true, lastCheckin: at(2026, 10, 22) }] }),
});
stub('src/qoder/grants', {
  readAll: () => [
    { grantId: 'g1', accountId: 9, amount: 100, grantedAt: at(2026, 10, 2, 10) },
    { grantId: 'g2', accountId: 9, amount: 50, grantedAt: at(2025, 12, 31, 10) },
  ],
});

const ledger = require('../src/checkin-ledger');
const { routes } = require('../src/admin/routes/checkin');
const route = routes[0];

function call(url) {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      writeHead(s) { status = s; },
      end(t) { resolve({ status, body: JSON.parse(t || '{}') }); },
    };
    Promise.resolve(route.handler({ res, req: { url } }))
      .catch((e) => resolve({ status: -1, body: { error: e.message } }));
  });
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures += 1; console.log(`[FAIL] ${label} — ${e.message}`); }
}

(async () => {
  console.log('== 账本：按天幂等 ==');
  check('同一天重复写只留一条', () => {
    assert.strictEqual(ledger.append({ channel: 'dumate', account_id: 1, day: '2026-10-03', source: 'claim', credits: 10 }), true);
    assert.strictEqual(ledger.append({ channel: 'dumate', account_id: 1, day: '2026-10-03', source: 'claim', credits: 10 }), false);
    assert.strictEqual(ledger.rowsInRange({ channel: 'dumate', fromDay: '2026-10-01', toDay: '2026-10-31' }).length, 1);
  });
  check('不同通道/账号互不影响', () => {
    assert.strictEqual(ledger.append({ channel: 'qoder', account_id: 1, day: '2026-10-03', source: 'claim' }), true);
    assert.strictEqual(ledger.append({ channel: 'dumate', account_id: 2, day: '2026-10-03', source: 'claim' }), true);
  });
  check('appendMany 批量去重', () => {
    const n = ledger.appendMany([
      { channel: 'traework', account_id: 7, day: '2026-10-04' },
      { channel: 'traework', account_id: 7, day: '2026-10-04' },
      { channel: 'traework', account_id: 7, day: '2026-10-05' },
    ]);
    assert.strictEqual(n, 2);
  });
  check('coverage 给出最早一天', () => {
    const c = ledger.coverage({ channel: 'traework' });
    assert.strictEqual(c.since, '2026-10-04');
  });
  check('dayOf 用本地日期（不是 UTC）', () => {
    // 本地 00:30 在 UTC 下可能是前一天；这里必须仍是本地当天
    assert.strictEqual(ledger.dayOf(new Date(2026, 9, 22, 0, 30).getTime()), '2026-10-22');
  });

  console.log('');
  console.log('== 搭子：上游当月 + 操作流水 + 账本 + lastCheckin 合并 ==');
  const d = await call('/detail?channel=dumate&year=2026&month=10');
  check('HTTP 200', () => assert.strictEqual(d.status, 200, JSON.stringify(d.body)));
  const a1 = d.body.accounts.find((a) => a.id === 1);
  check('上游当月已签日进账（source=upstream）', () => {
    assert.strictEqual(a1.days['2026-10-01'].source, 'upstream');
    assert.strictEqual(a1.days['2026-10-02'].source, 'upstream');
  });
  check('本地账本与操作流水也合并', () => {
    assert.ok(a1.days['2026-10-03'], '缺账本 10-03');
    assert.ok(a1.days['2026-09-22'], '缺流水 09-22');
  });
  check('失败的签到不算「签过」', () => assert.ok(!a1.days['2026-09-23']));
  check('lastCheckin 兜底补一天', () => assert.strictEqual(a1.days['2026-10-20'].source, 'account'));
  // 10-01/02 上游、10-03 账本、10-20 lastCheckin
  check('本月天数只数当月', () => assert.strictEqual(a1.daysInMonth, 4));
  check('上游查询失败如实报出', () => {
    assert.strictEqual(d.body.upstream.failed, 1);
    assert.strictEqual(d.body.upstream.ok, 1);
  });
  check('按年汇总：9 月 1 天、10 月 4 天', () => {
    const m9 = d.body.months.find((m) => m.month === 9);
    const m10 = d.body.months.find((m) => m.month === 10);
    assert.strictEqual(m9.days, 1);
    assert.strictEqual(m10.days, 4);
  });
  check('覆盖范围取最早数据点（含操作流水）', () => assert.strictEqual(d.body.coverage.since, '2026-09-22'));

  console.log('');
  console.log('== Qoder：领取账本 + lastCheckin ==');
  const q = await call('/detail?channel=qoder&year=2026&month=10');
  check('HTTP 200', () => assert.strictEqual(q.status, 200, JSON.stringify(q.body)));
  const q1 = q.body.accounts[0];
  check('领取批次按领取时刻归日', () => assert.strictEqual(q1.days['2026-10-02'].source, 'grant'));
  check('领取额带出来（不是剩余额）', () => assert.strictEqual(q1.days['2026-10-02'].credits, 100));
  check('跨年批次不计入今年', () => {
    const m12 = q.body.months.find((m) => m.month === 12);
    assert.strictEqual(m12.accountDays, 0);
  });
  check('覆盖范围含 2025 年的批次', () => assert.strictEqual(q.body.coverage.since, '2025-12-31'));

  console.log('');
  console.log('== TRAE：只有本地数据 ==');
  const t = await call('/detail?channel=traework&year=2026&month=10');
  check('HTTP 200', () => assert.strictEqual(t.status, 200, JSON.stringify(t.body)));
  check('lastCheckin 补进当月，且覆盖范围取账本最早一天', () => {
    assert.ok(t.body.accounts[0].days['2026-10-21'], '缺 lastCheckin 那天');
    assert.strictEqual(t.body.coverage.since, '2026-10-04');
  });

  console.log('');
  console.log('== 千问办公：没有签到体系 ==');
  const w = await call('/detail?channel=qwenwork&year=2026&month=10');
  check('返回 400 并说明原因', () => {
    assert.strictEqual(w.status, 400);
    assert.ok(/签到/.test(w.body.error), w.body.error);
  });

  console.log('');
  if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
  console.log('全部通过');
  process.exit(0);
})();
