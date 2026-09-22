// src/admin/routes/accounts.js - 网页端账号管理（多账号签到 / 抽奖 / 积分）
const crypto = require('crypto');
const accounts = require('../../accounts');
const web = require('../../dumate-web');
const loginBrowser = require('../../login-browser');
const webPool = require('../../web-pool');
const taskRunner = require('../../task-runner');
const taskScheduler = require('../../task-scheduler');
const records = require('../../records');
const { sendJSON } = require('../router');

// 登录链接。百度 SSO 的登录页，登录后 cookie 落在 .baidu.com 域，
// 正是调 console/dumate 接口需要的。
const LOGIN_URL = 'https://login.bce.baidu.com/?redirect=' +
  encodeURIComponent('https://www.dumate.cn/app');

// 签到结果写回账号记录。抽出来单独一个函数是因为「一键签到」和
// 「单账号签到」两条路径都要用，且都要在失败时记下原因。
async function doCheckin(account) {
  // 动作前的积分快照，用于算这次签到带来多少积分变化。
  // 放在最前面取：已签到的分支不需要它，但多取一次的成本远低于
  // 「有的分支有差值、有的没有」造成的记录不一致。
  account._pointsBefore = await records.pointsSnapshot(account.cookie);

  const info = await web.api.loginBonusInfo(account.cookie);
  if (!info.ok) {
    accounts.patchInternal(account.id, {
      last_error: info.error,
      last_login_ok_at: info.expired ? null : account.last_login_ok_at,
    });
    records.append({
      type: 'checkin', account_id: account.id, account: account.name,
      ok: false, result: 'failed', error: info.error,
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
    // 已签到的分支也记录，但积分变化是 0——这次确实没有发放。
    // 记 0 而不是留空，因为「这次没发」和「没测到」是两件事。
    // 前后值用当前余额（两者相同），让表格里这一行的格式与其他行一致。
    const cur = account._pointsBefore ? account._pointsBefore.left : null;
    records.append({
      type: 'checkin', account_id: account.id, account: account.name,
      ok: true, result: 'already', total_times: info.total_times,
      total_points: info.total_points,
      points_delta: 0, points_before: cur, points_after: cur,
    });
    return {
      id: account.id, name: account.name, ok: true, already: true, info,
      points_delta: 0, points_before: cur, points_after: cur,
    };
  }

  const res = await web.api.claimLoginBonus(account.cookie);
  // 签到前先取一次积分快照，签完再取一次，差值就是这次签到发了多少。
  // 上游不返回金额，只能用余额差值——这是实测真值，不是估算。
  const afterPoints = res.ok ? await records.pointsSnapshot(account.cookie) : null;
  const pd = records.pointsDelta(account._pointsBefore, afterPoints);

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
  records.append({
    type: 'checkin', account_id: account.id, account: account.name,
    ok: res.ok, result: res.ok ? 'claimed' : 'failed',
    total_times: info.total_times,
    total_points: info.total_points,
    points_delta: pd.delta,
    points_before: pd.before,
    points_after: pd.after,
    error: res.error || '',
  });
  return {
    id: account.id, name: account.name, ok: res.ok, error: res.error, info,
    points_delta: pd.delta, points_before: pd.before, points_after: pd.after,
  };
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
    // 所有账号的积分明细（并发拉取）。
    // 积分明细页原先只看本地后端那一个账号，但账号管理里可以有多份网页凭证，
    // 每份都能独立查积分——只看一个会漏掉其余账号。
    method: 'GET',
    path: '/points-all',
    handler: async ({ res, req }) => {
      const force = /[?&]refresh=1/.test(req.url || '');
      const list = accounts.load().accounts.filter((a) => a.enabled);

      const results = await Promise.all(list.map(async (a) => {
        // 不强制刷新时优先用缓存：上游一次往返 200-800ms，账号多时并发也要时间
        if (!force && a.points && a.points_at && Date.now() - a.points_at < 60_000) {
          return { id: a.id, name: a.name, nickname: a.nickname || '', ok: true, cached: true, ...a.points };
        }
        const r = await web.api.quotaOverview(a.cookie);
        if (!r.ok) {
          accounts.patchInternal(a.id, { last_error: r.error });
          return { id: a.id, name: a.name, nickname: a.nickname || '', ok: false, error: r.error, expired: !!r.expired };
        }
        const summary = { left: r.left, total: r.total, used: r.used };
        accounts.patchInternal(a.id, { points: summary, points_at: Date.now(), last_error: '' });
        return {
          id: a.id, name: a.name, nickname: a.nickname || '', ok: true, cached: false,
          ...summary, subscribed: r.subscribed, throttled: r.throttled, packages: r.packages,
        };
      }));

      const ok = results.filter((r) => r.ok);
      return sendJSON(res, 200, {
        accounts: results,
        // 汇总口径：只累加取到数据的账号，避免失败的账号把总数拉低
        totals: {
          accounts: results.length,
          ok_accounts: ok.length,
          left: ok.reduce((s, r) => s + (r.left || 0), 0),
          total: ok.reduce((s, r) => s + (r.total || 0), 0),
          used: ok.reduce((s, r) => s + (r.used || 0), 0),
        },
      });
    },
  },
  {
    // 任务状态（只读）。列出每个账号的任务与完成情况，不执行任何动作。
    method: 'GET',
    path: '/tasks',
    handler: async ({ res }) => {
      const list = await taskRunner.listTasks();
      return sendJSON(res, 200, {
        accounts: list,
        auto_types: [...taskRunner.AUTO_TYPES],
        // 说明自动化边界，避免「为什么这几个没做」被当成漏跑
        not_automatable: {
          PC_PUSH: '网页端不支持，需在桌面端或移动端完成',
          INVITATION: '需要真人注册',
          INVITED: '需要他人的邀请码',
        },
        runs: taskRunner.recentRuns(20),
      });
    },
  },
  {
    // 跑任务：把各账号可自动完成的任务做完（QUERY_INPUT / USE_SKILL）
    method: 'POST',
    path: '/tasks/run',
    handler: async ({ res, body }) => {
      const only = body && body.account_id ? Number(body.account_id) : null;
      let results;
      if (only) {
        const acc = accounts.get(only);
        if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
        results = [await taskRunner.runForAccount(acc)];
      } else {
        results = await taskRunner.runAll();
      }
      const done = results.reduce((s, r) => s + (r.done_count || 0), 0);
      const fail = results.reduce((s, r) => s + (r.fail_count || 0), 0);
      require('../../admin/auth').audit('admin', 'task_run', '', `完成 ${done}，失败 ${fail}`);
      return sendJSON(res, 200, { results, done_count: done, fail_count: fail });
    },
  },
  {
    // 一键抽奖：把所有账号的可用次数抽完（可选自动领奖）
    method: 'POST',
    path: '/draw-all',
    handler: async ({ res, body }) => {
      const autoClaim = !body || body.claim !== false;
      const list = accounts.load().accounts.filter((a) => a.enabled);
      const out = [];

      for (const a of list) {
        const st = await web.api.drawStatus(a.cookie);
        if (!st.ok) { out.push({ id: a.id, name: a.name, ok: false, error: st.error }); continue; }

        // 抽奖前后的积分快照：抽到积分类奖品会让总量上涨，
        // 差值就是这一轮实际到手的积分。
        const beforePoints = await records.pointsSnapshot(a.cookie);

        let remaining = st.remaining_draws || 0;
        const draws = [];
        // 抽到没次数为止。上限 20 次防止服务端计数异常时无限循环。
        for (let i = 0; i < Math.min(remaining, 20); i++) {
          const r = await web.api.draw(a.cookie, crypto.randomUUID());
          draws.push(r);
          if (!r.ok) break;
          if (r.remaining_draws !== null && r.remaining_draws <= 0) break;
        }

        // 领奖：只有「非 SUCCESS 且需要联系方式」的奖品才需要领。
        // 实测所有积分/会员奖品抽到即 status=SUCCESS，自动到账，无需领取；
        // 之前按 claimed 字段判断（该字段不存在）导致把已完成的当成待领，
        // 逐个去领反而报「参数错误:DrawRecordID」。
        let claimed = [];
        if (autoClaim) {
          const after = await web.api.drawStatus(a.cookie);
          const pending = (after.ok ? after.my_prizes : []).filter(
            (p) => p.status && p.status !== 'SUCCESS' && p.draw_record_id,
          );
          for (const p of pending.slice(0, 10)) {
            const c = await web.api.claimPrize(a.cookie, p.draw_record_id);
            claimed.push({ prize: p.prize_name, ok: c.ok, error: c.error || '' });
          }
        }

        // 抽到的奖品按类型汇总，让界面能直接说「抽到了什么」
        const finalStatus = await web.api.drawStatus(a.cookie);
        const wonPrizes = [];
        if (finalStatus.ok) {
          const before = new Set((st.my_prizes || []).map((p) => p.draw_record_id));
          for (const p of (finalStatus.my_prizes || [])) {
            if (!before.has(p.draw_record_id)) {
              wonPrizes.push({ name: p.prize_name, type: p.prize_type, value: p.prize_value, status: p.status });
            }
          }
        }

        // 一次抽奖可能连抽多次，按「每次抽到的奖品」逐条记录，
        // 这样记录页能列出具体中了什么而不是只写「抽了 N 次」。
        // 积分变化记在第一条上（整轮的总变化），避免每条都重复同一个数。
        const dp = records.pointsDelta(beforePoints, await records.pointsSnapshot(a.cookie));
        for (let i = 0; i < wonPrizes.length; i++) {
          const w = wonPrizes[i];
          records.append({
            type: 'draw', account_id: a.id, account: a.name,
            ok: true, prize: w.name, prize_type: w.type, prize_value: w.value,
            points_delta: i === 0 ? dp.delta : null,
            points_before: i === 0 ? dp.before : null,
            points_after: i === 0 ? dp.after : null,
          });
        }
        if (!wonPrizes.length && draws.length) {
          records.append({
            type: 'draw', account_id: a.id, account: a.name,
            ok: draws.some((d) => d.ok), count: draws.filter((d) => d.ok).length,
            points_delta: dp.delta, points_before: dp.before, points_after: dp.after,
          });
        }

        out.push({
          id: a.id, name: a.name, ok: true,
          before: remaining,
          drawn: draws.filter((d) => d.ok).length,
          remaining_after: draws.length ? draws[draws.length - 1].remaining_draws : remaining,
          results: draws,
          claimed,
          won: wonPrizes,
          points_delta: dp.delta,
        });
      }

      const total = out.reduce((s, r) => s + (r.drawn || 0), 0);
      require('../../admin/auth').audit('admin', 'draw_all', '', `抽奖 ${total} 次`);
      return sendJSON(res, 200, { results: out, drawn_count: total });
    },
  },
  {
    // 任务轮询开关与状态。间隔的定法（含抖动）写在 rationale 里一并返回，
    // 界面直接展示，避免「这个间隔是怎么来的」只能靠猜。
    method: 'GET',
    path: '/tasks/schedule',
    handler: ({ res }) => sendJSON(res, 200, taskScheduler.snapshot()),
  },
  {
    method: 'POST',
    path: '/tasks/schedule',
    handler: ({ res, body }) => {
      try {
        const r = taskScheduler.configure(body || {});
        require('../../admin/auth').audit('admin', 'task_schedule_config',
          r.enabled ? 'on' : 'off', `${r.minutes} 分钟`);
        return sendJSON(res, 200, r);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    },
  },
  {
    // 立即跑一轮（不等定时器），用于验证配置
    method: 'POST',
    path: '/tasks/poll-now',
    handler: async ({ res }) => {
      const r = await taskScheduler.runOnce('manual');
      return sendJSON(res, 200, r);
    },
  },
  {
    // 操作记录：签到 / 任务 / 抽奖，按时间倒序。
    // 支持按账号、类型、天数过滤，前端用同一份数据出列表和日历两种视图。
    method: 'GET',
    path: '/records',
    handler: ({ res, req }) => {
      const q = (k) => (req.url.match(new RegExp(`[?&]${k}=([^&]*)`)) || [])[1];
      const limit = Math.min(1000, parseInt(q('limit') || '200', 10) || 200);
      const accountId = q('account_id') ? Number(decodeURIComponent(q('account_id'))) : null;
      const type = q('type') ? decodeURIComponent(q('type')) : null;
      const days = Math.min(180, Math.max(1, parseInt(q('days') || '30', 10) || 30));
      const since = Date.now() - days * 86400000;

      const { rows, total } = records.read({ limit, account_id: accountId, type, since });
      return sendJSON(res, 200, {
        rows,
        total,
        days,
        // 日历视图要的按天聚合
        daily: records.dailySummary(days),
        // 记录类型与含义，前端据此渲染标签，避免各处自己硬编码
        types: {
          checkin: '签到',
          task: '任务',
          draw: '抽奖',
        },
      });
    },
  },
  {
    // 各账号的签到日历（直接取上游的 sign_in_days，不受本地记录起点限制）
    method: 'GET',
    path: '/checkin-calendar',
    handler: async ({ res, req }) => {
      const months = Math.min(6, Math.max(1, parseInt((req.url.match(/[?&]months=(\d+)/) || [])[1] || '1', 10)));
      const list = accounts.load().accounts.filter((a) => a.enabled);
      const out = [];

      for (const a of list) {
        const info = await web.api.loginBonusInfo(a.cookie);
        out.push({
          account_id: a.id,
          name: a.name,
          nickname: a.nickname || '',
          ok: info.ok,
          error: info.ok ? '' : info.error,
          has_issued_today: info.ok ? info.has_issued : null,
          total_times: info.ok ? info.total_times : null,
          // 上游返回的是「哪些天签过」，这是权威数据；
          // 本地记录只能回答「我什么时候去点的」，两者互补
          sign_in_days: info.ok ? (info.sign_in_days || []) : [],
        });
      }
      return sendJSON(res, 200, { accounts: out, months });
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
