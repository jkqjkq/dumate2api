// src/admin/routes/accounts.js - 网页端账号管理（多账号签到 / 抽奖 / 积分）
const crypto = require('crypto');
const accounts = require('../../accounts');
const web = require('../../dumate-web');
const loginBrowser = require('../../login-browser');
const webPool = require('../../web-pool');
const { sendJSON } = require('../router');

// 登录链接。百度 SSO 的登录页，登录后 cookie 落在 .baidu.com 域，
// 正是调 console/dumate 接口需要的。
const LOGIN_URL = 'https://login.bce.baidu.com/?redirect=' +
  encodeURIComponent('https://www.dumate.cn/app');

// 签到结果写回账号记录。抽出来单独一个函数是因为「一键签到」和
// 「单账号签到」两条路径都要用，且都要在失败时记下原因。
async function doCheckin(account) {
  const info = await web.api.loginBonusInfo(account.cookie);
  if (!info.ok) {
    accounts.patchInternal(account.id, {
      last_error: info.error,
      last_login_ok_at: info.expired ? null : account.last_login_ok_at,
    });
    return { id: account.id, name: account.name, ok: false, error: info.error, expired: !!info.expired };
  }

  // 已签到就不再打上游：签到接口本身幂等，但重复调用没有意义，
  // 而且会让「今天是否签到成功」这件事难以判断
  if (info.has_issued) {
    accounts.patchInternal(account.id, {
      last_error: '',
      last_login_ok_at: Date.now(),
      checkin: {
        ...account.checkin,
        last_result: 'already',
        total_times: info.total_times,
        sign_in_days: info.sign_in_days,
        month_points: info.month_points,
      },
    });
    return { id: account.id, name: account.name, ok: true, already: true, info };
  }

  const res = await web.api.claimLoginBonus(account.cookie);
  accounts.patchInternal(account.id, {
    last_error: res.ok ? '' : res.error,
    last_login_ok_at: res.ok ? Date.now() : account.last_login_ok_at,
    checkin: {
      ...account.checkin,
      last_at: res.ok ? Date.now() : account.checkin.last_at,
      last_result: res.ok ? 'claimed' : 'failed',
      total_times: info.total_times,
      sign_in_days: info.sign_in_days,
      month_points: info.month_points,
    },
  });
  return { id: account.id, name: account.name, ok: res.ok, error: res.error, info };
}

const routes = [
  {
    // 登录器：打开一个受控浏览器窗口，登录后自动抓 cookie。
    // 这是「不依赖用户浏览器状态」的唯一自动路径——搭子没有登录票据接口，
    // 而系统浏览器的 cookie 库在运行时被独占锁定。
    method: 'POST',
    path: '/login/start',
    handler: async ({ res, body }) => {
      const r = await loginBrowser.start({ name: (body && body.name) || '' });
      if (!r.ok) return sendJSON(res, 400, r);
      require('../../admin/auth').audit('admin', 'web_login_start', '', r.browser_path || '');
      return sendJSON(res, 200, r);
    },
  },
  {
    // 轮询登录状态。成功时把 cookie 落库并清空暂存——同一份凭证不能入库两次。
    method: 'GET',
    path: '/login/poll',
    handler: async ({ res, req }) => {
      const s = loginBrowser.snapshot();
      if (s.status === 'success' && s.has_cookie) {
        const cookie = loginBrowser.takeCookie();
        const wantName = (req.url.match(/[?&]name=([^&]*)/) || [])[1];
        try {
          // 先问上游这个 cookie 是谁：昵称和 uid 是列表页展示要用的，
          // 拿不到就退回「账号 N」，不要让入库因为一次查询失败而中断
          let info = null;
          try { info = await web.api.userInfo(cookie); } catch (e) { info = null; }
          const name = (wantName ? decodeURIComponent(wantName) : '') ||
            (info && info.nickname) || '';

          const created = accounts.create({ cookie, name });
          if (info && info.ok) {
            accounts.patchInternal(created.id, {
              uid: info.uid || '',
              nickname: info.nickname || '',
              last_login_ok_at: Date.now(),
              last_error: '',
            });
          }
          require('../../admin/auth').audit('admin', 'web_account_create', created.name, 'via browser');
          return sendJSON(res, 200, {
            ...s, status: 'saved', has_cookie: false,
            account: accounts.get(created.id) ? {
              ...created, uid: info?.uid || '', nickname: info?.nickname || '',
            } : created,
          });
        } catch (e) {
          // 已存在同账号等：如实报错，但不把 cookie 丢掉——用户可改用粘贴方式
          return sendJSON(res, 409, { ...s, status: 'failed', message: e.message });
        }
      }
      return sendJSON(res, 200, s);
    },
  },
  {
    method: 'POST',
    path: '/login/cancel',
    handler: ({ res }) => sendJSON(res, 200, loginBrowser.cancel()),
  },
  {
    // 手动粘贴入口（保留）：浏览器登录器不可用时（无 Edge/Chrome）的兜底
    method: 'GET',
    path: '/login-url',
    handler: ({ res }) => sendJSON(res, 200, {
      url: LOGIN_URL,
      steps: [
        '点击链接，在打开的页面登录百度账号',
        '登录成功后回到本页，打开浏览器开发者工具（F12）',
        '切到 Application → Cookies → https://www.dumate.cn',
        '全选复制所有 cookie，粘贴到下面的输入框',
      ],
      note: '百度登录态位于 baidu.com 域，网页无法直接读取浏览器 cookie，所以需要手动复制一次',
      browser_available: !!loginBrowser.findBrowser(),
    }),
  },
  {
    method: 'GET',
    path: '',
    handler: ({ res }) => sendJSON(res, 200, {
      accounts: accounts.list(),
      login_url: LOGIN_URL,
      file: accounts.filePath(),
    }),
  },
  {
    method: 'POST',
    path: '',
    handler: ({ res, body }) => {
      try {
        const created = accounts.create(body || {});
        require('../../admin/auth').audit('admin', 'web_account_create', created.name);
        return sendJSON(res, 200, created);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    },
  },
  {
    // 验证 cookie 是否可用：调用 user/info，顺便把昵称回填到账号记录
    method: 'POST',
    path: '/verify',
    handler: async ({ res, body }) => {
      const cookie = accounts.normalizeCookie(body && body.cookie);
      if (!cookie) return sendJSON(res, 400, { error: 'cookie 不能为空' });
      const r = await web.api.userInfo(cookie);
      return sendJSON(res, r.ok ? 200 : 401, r.ok
        ? { ok: true, uid: r.uid, nickname: r.nickname }
        : { ok: false, error: r.error, expired: !!r.expired });
    },
  },
  {
    method: 'PATCH',
    path: '/:id',
    handler: ({ res, body, params }) => {
      try {
        const updated = accounts.update(params[0], body || {});
        if (!updated) return sendJSON(res, 404, { error: '账号不存在' });
        return sendJSON(res, 200, updated);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    },
  },
  {
    method: 'DELETE',
    path: '/:id',
    handler: ({ res, params }) => {
      const ok = accounts.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: '账号不存在' });
      require('../../admin/auth').audit('admin', 'web_account_delete', params[0]);
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    // 单账号签到
    method: 'POST',
    path: '/:id/checkin',
    handler: async ({ res, params }) => {
      const acc = accounts.get(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const result = await doCheckin(acc);
      require('../../admin/auth').audit('admin', 'web_checkin', acc.name, result.ok ? 'ok' : result.error);
      return sendJSON(res, result.ok ? 200 : 502, result);
    },
  },
  {
    // 一键签到：并发跑所有启用账号，单个失败不影响其余
    method: 'POST',
    path: '/checkin-all',
    handler: async ({ res }) => {
      const targets = accounts.load().accounts.filter((a) => a.enabled);
      if (!targets.length) return sendJSON(res, 200, { results: [], ok_count: 0, fail_count: 0 });
      const results = await Promise.all(targets.map((a) => doCheckin(a)));
      const ok = results.filter((r) => r.ok).length;
      require('../../admin/auth').audit('admin', 'web_checkin_all', '', `${ok}/${results.length}`);
      return sendJSON(res, 200, { results, ok_count: ok, fail_count: results.length - ok });
    },
  },
  {
    // 账号详情：签到信息 + 抽奖状态 + 积分，并发取
    method: 'GET',
    path: '/:id/status',
    handler: async ({ res, params }) => {
      const acc = accounts.get(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });

      const [bonus, draw, points, tasks] = await Promise.all([
        web.api.loginBonusInfo(acc.cookie),
        web.api.drawStatus(acc.cookie),
        web.api.quotaOverview(acc.cookie),
        web.api.tasks(acc.cookie),
      ]);

      // 登录态失效是最需要立刻知道的状态，单独置顶
      const expired = [bonus, draw, points].some((r) => r.expired);

      // 顺手回填缓存，列表页不必再单独请求
      accounts.patchInternal(acc.id, {
        last_error: expired ? '登录态已失效' : '',
        checkin: bonus.ok ? {
          ...acc.checkin,
          last_result: bonus.has_issued ? 'already' : acc.checkin.last_result,
          total_times: bonus.total_times,
          sign_in_days: bonus.sign_in_days,
          month_points: bonus.month_points,
        } : acc.checkin,
        lottery: draw.ok ? {
          ...acc.lottery,
          remaining: draw.remaining_draws,
          my_prizes: draw.my_prizes,
        } : acc.lottery,
        points: points.ok ? { left: points.left, total: points.total, used: points.used } : acc.points,
        points_at: points.ok ? Date.now() : acc.points_at,
      });

      return sendJSON(res, 200, {
        id: acc.id,
        name: acc.name,
        expired,
        checkin: bonus.ok ? {
          has_issued: bonus.has_issued,
          total_times: bonus.total_times,
          sign_in_days: bonus.sign_in_days,
          month_points: bonus.month_points,
        } : { error: bonus.error },
        lottery: draw.ok ? {
          remaining_draws: draw.remaining_draws,
          prizes: draw.prizes,
          my_prizes: draw.my_prizes,
          winning_records: draw.winning_records,
        } : { error: draw.error },
        points: points.ok ? {
          left: points.left, total: points.total, used: points.used,
          subscribed: points.subscribed, throttled: points.throttled,
          packages: points.packages,
        } : { error: points.error },
        tasks: tasks.ok ? tasks.tasks : { error: tasks.error },
      });
    },
  },
  {
    // 抽奖。次数由服务端扣减，这里只负责发起并把结果写回。
    method: 'POST',
    path: '/:id/draw',
    handler: async ({ res, params, body }) => {
      const acc = accounts.get(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const times = Math.max(1, Math.min(10, parseInt((body && body.times) || 1, 10)));

      const results = [];
      for (let i = 0; i < times; i++) {
        // 幂等键必须每次不同：复用会让服务端把后续请求当成重复提交
        const rid = crypto.randomUUID();
        const r = await web.api.draw(acc.cookie, rid);
        results.push(r);
        if (!r.ok) break;
        if (r.remaining_draws !== null && r.remaining_draws <= 0) break;
      }

      const last = results[results.length - 1] || {};
      accounts.patchInternal(acc.id, {
        lottery: {
          ...acc.lottery,
          remaining: last.remaining_draws !== undefined ? last.remaining_draws : acc.lottery.remaining,
          last_at: Date.now(),
          last_result: results.every((r) => r.ok) ? 'ok' : 'failed',
        },
      });
      require('../../admin/auth').audit('admin', 'web_draw', acc.name, `${results.length} 次`);
      return sendJSON(res, 200, {
        results,
        ok_count: results.filter((r) => r.ok).length,
        remaining_draws: last.remaining_draws,
      });
    },
  },
  {
    // 领奖
    method: 'POST',
    path: '/:id/claim-prize',
    handler: async ({ res, params, body }) => {
      const acc = accounts.get(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const prizeId = body && body.prize_id;
      if (!prizeId) return sendJSON(res, 400, { error: '缺少 prize_id' });
      const r = await web.api.claimPrize(acc.cookie, prizeId);
      return sendJSON(res, r.ok ? 200 : 502, r);
    },
  },
  {
    method: 'GET',
    path: '/:id/points',
    handler: async ({ res, params }) => {
      const acc = accounts.get(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const [points, charge, usage] = await Promise.all([
        web.api.quotaOverview(acc.cookie),
        web.api.chargeRecords(acc.cookie),
        web.api.usageRecords(acc.cookie),
      ]);
      if (!points.ok) return sendJSON(res, 502, { error: points.error, expired: !!points.expired });
      return sendJSON(res, 200, {
        ...points,
        charge_records: charge.ok ? charge.records : null,
        usage_records: usage.ok ? usage.records : null,
      });
    },
  },
  {
    method: 'GET',
    path: '/pool',
    handler: ({ res }) => {
      // 账号池的运行态（token 缓存、成功/失败计数、冷却）只存在于网关进程内，
      // 管理端是另一个进程读不到。这里返回「配置 + 最近一次探测结果」，
      // 需要实时运行态就查网关的 /health。
      const gatewayPort = parseInt(process.env.DUMATE_WEB_GATEWAY_PORT || '9084', 10);
      const list = accounts.load().accounts.map((a) => ({
        id: a.id,
        name: a.name,
        nickname: a.nickname || '',
        enabled: a.enabled,
        last_error: a.last_error || '',
        points: a.points ? a.points.left : null,
        checkin_result: (a.checkin && a.checkin.last_result) || '',
      }));

      // 顺带探一下网关是否在跑，界面据此提示「先启动 9084」
      const req = require('http').request(
        { host: '127.0.0.1', port: gatewayPort, path: '/health', method: 'GET', timeout: 3000 },
        (r) => {
          let d = '';
          r.setEncoding('utf8');
          r.on('data', (c) => { d += c; });
          r.on('end', () => {
            let health = null;
            try { health = JSON.parse(d); } catch (e) { health = null; }
            sendJSON(res, 200, { gateway_port: gatewayPort, gateway_online: true, health, accounts: list });
          });
        },
      );
      req.on('error', () => sendJSON(res, 200, {
        gateway_port: gatewayPort, gateway_online: false, health: null, accounts: list,
      }));
      req.on('timeout', () => { req.destroy(); });
      req.end();
    },
  },
  {
    // 探测某账号能否跑模型（走一次真实的 1-token 调用）
    method: 'POST',
    path: '/:id/probe-model',
    handler: async ({ res, params }) => {
      const acc = accounts.get(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const r = await webPool.probe(acc.id);
      return sendJSON(res, r.ok ? 200 : 502, r);
    },
  },
];

module.exports = { routes, LOGIN_URL, doCheckin };
