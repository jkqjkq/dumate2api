// src/admin/routes/points.js - 积分与账号概览
//
// 数据源是 DuMate 后端的 /api/dumate/points/quota_overview，它把套餐订阅
// 与一堆增量包（登录奖励、活动奖励）分开返回，两个数组各自带 usedPoints，
// 界面需要的是「还剩多少」，所以在这里统一算好再吐给前端。
const http = require('http');
const fs = require('fs');
const path = require('path');
const discovery = require('../../discovery');
const { sendJSON } = require('../router');

const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, data: null };

function upstreamJSON(port, urlPath, timeout = 8000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', timeout },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ ok: false, error: 'invalid json' }); }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

// 账号列表来自客户端的 auth.json。cookie 是加密的，这里只取身份与登录时间，
// 不碰也不回传任何凭证字段。
function listAccounts() {
  const file = path.join(process.env.APPDATA || '', 'qianfan-desktop-app', 'auth.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  const profiles = j.accountProfiles || [];
  const now = Date.now();
  return profiles.map((p) => {
    const lastLogin = p.lastLogin || 0;
    const ageDays = lastLogin ? Math.floor((now - lastLogin) / 86400000) : null;
    const active = p.profileId === j.activeProfileId;
    // 凭证分布：活跃账号的 cookie 存在顶层 cookies 字段，非活跃账号只有自己
    // 的 encryptedCookies 才代表它还能用。只看 lastLogin 会把一个早就没有
    // 凭证的历史账号报成「有效」，所以凭证缺失优先判为失效。
    const hasCredentials = !!p.encryptedCookies || active;
    let state;
    if (!hasCredentials) state = 'stale';
    else if (ageDays === null) state = 'unknown';
    else if (ageDays > 30) state = 'stale';
    else state = 'active';
    return {
      name: p.displayName || '(未命名)',
      user_id: p.bceUserId || '',
      last_login: lastLogin,
      age_days: ageDays,
      state,
      has_credentials: hasCredentials,
      active,
    };
  });
}

async function fetchPoints() {
  const port = await discovery.discoverPort();
  if (!port) return { ok: false, error: 'upstream not found' };

  const [overview, remaining] = await Promise.all([
    upstreamJSON(port, '/api/dumate/points/quota_overview'),
    upstreamJSON(port, '/api/dumate/points/remaining'),
  ]);

  if (!overview.ok || !overview.data || !overview.data.success) {
    return { ok: false, error: (overview.data && overview.data.message) || overview.error || 'upstream error' };
  }

  const r = overview.data.result || {};
  const total = Number(r.totalPoints || 0);
  const used = Number(r.usedPoints || 0);

  const packages = []
    .concat((r.subscription || []).map((p) => ({ ...p, kind: 'subscription' })))
    .concat((r.incremental || []).map((p) => ({ ...p, kind: 'incremental' })))
    .map((p) => {
      const t = Number(p.totalPoints || 0);
      const u = Number(p.usedPoints || 0);
      return {
        kind: p.kind,
        package_type: p.packageType || '',
        source: p.source || '',
        total: t,
        used: u,
        left: Math.max(0, t - u),
        // 发放时间：分析「每日奖励是否还在发」必须用它，而不是到期时间
        granted_at: p.startDate ? p.startDate * 1000 : null,
        expire_at: p.expireDate ? p.expireDate * 1000 : null,
        status: p.status || '',
      };
    });

  // 最近到期的未用完包：这是「即将过期」提示的依据，全量 89 个包里
  // 绝大多数已用尽，只有未用尽的才值得提醒
  const expiring = packages
    .filter((p) => p.left > 0 && p.expire_at)
    .sort((a, b) => a.expire_at - b.expire_at)
    .slice(0, 10);

  // 按来源聚合。积分明细里最有信息量的一层：能看出「每天自动发的登录奖励」
  // 和「成长计划奖励」各占多少、是否还在持续发放。
  const bySource = {};
  for (const p of packages) {
    const k = p.source || '(未知来源)';
    if (!bySource[k]) {
      bySource[k] = { source: k, count: 0, total: 0, used: 0, left: 0, first_at: null, last_at: null, active_days: new Set() };
    }
    const s = bySource[k];
    s.count++;
    s.total += p.total;
    s.used += p.used;
    s.left += p.left;
    // 用发放日期而非到期日：想知道的是「还在不在发」
    const day = p.granted_at ? new Date(p.granted_at).toISOString().slice(0, 10) : null;
    if (day) {
      s.active_days.add(day);
      if (!s.first_at || p.granted_at < s.first_at) s.first_at = p.granted_at;
      if (!s.last_at || p.granted_at > s.last_at) s.last_at = p.granted_at;
    }
  }
  const sources = Object.values(bySource).map((s) => ({
    ...s,
    active_days: s.active_days.size,
    days_since_last: s.last_at ? Math.floor((Date.now() - s.last_at) / 86400000) : null,
  })).sort((a, b) => b.total - a.total);

  // 按发放日聚合，给出每日新增额度曲线（与「每日消耗」是两回事）
  const byDay = {};
  for (const p of packages) {
    if (!p.granted_at) continue;
    const k = new Date(p.granted_at).toISOString().slice(0, 10);
    if (!byDay[k]) byDay[k] = { day: k, granted: 0, used: 0, count: 0 };
    byDay[k].granted += p.total;
    byDay[k].used += p.used;
    byDay[k].count++;
  }
  const dailyGrant = Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1));

  return {
    ok: true,
    data: {
      subscribed: !!r.isSubscribed,
      total,
      used,
      left: Math.max(0, total - used),
      has_remaining: remaining.ok && remaining.data ? !!remaining.data.hasRemainingPoints : null,
      throttled: !!(r.modelThrottleInfo && r.modelThrottleInfo.throttled),
      throttle_reason: (r.modelThrottleInfo && r.modelThrottleInfo.reason) || '',
      packages,
      expiring,
      sources,
      daily_grant: dailyGrant,
      // 已过期但还有余额的包：这部分额度实际已经用不上了，单独列出来
      // 说明「总额度」里有多少是已经失效的
      expired_unused: packages.filter((p) => p.left > 0 && p.expire_at && p.expire_at < Date.now()),
      upstream_port: port,
      fetched_at: Date.now(),
    },
  };
}

const routes = [
  {
    method: 'GET',
    path: '/points',
    handler: async ({ res, req }) => {
      const force = /[?&]refresh=1/.test(req.url || '');
      if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
        return sendJSON(res, 200, { ...cache.data, cached: true });
      }
      const out = await fetchPoints();
      if (!out.ok) return sendJSON(res, 502, { error: out.error });
      cache = { at: Date.now(), data: out.data };
      return sendJSON(res, 200, { ...out.data, cached: false });
    },
  },
  {
    method: 'GET',
    path: '/accounts',
    handler: async ({ res }) => {
      const accounts = listAccounts();
      if (accounts === null) return sendJSON(res, 502, { error: 'auth.json not readable' });

      // 积分只能查到「当前登录的那个账号」：上游的 quota_overview 是按后端
      // 进程内注入的登录态算的，实测传任意 Cookie 头都不影响返回值，
      // 也没有 userId 参数。所以这里只给活跃账号挂积分，其余如实标为不可查，
      // 不拿活跃账号的数字去填别人。
      let activePoints = null;
      let pointsError = null;
      try {
        const out = await fetchPoints();
        if (out.ok) activePoints = { left: out.data.left, total: out.data.total, used: out.data.used };
        else pointsError = out.error;
      } catch (e) {
        pointsError = e.message;
      }

      const withPoints = accounts.map((a) => ({
        ...a,
        points: a.active ? activePoints : null,
        points_note: a.active
          ? (activePoints ? '' : (pointsError || '积分查询失败'))
          : '仅当前登录账号可查',
      }));

      return sendJSON(res, 200, {
        accounts: withPoints,
        total: withPoints.length,
        active: withPoints.filter((a) => a.state === 'active').length,
        stale: withPoints.filter((a) => a.state === 'stale').length,
        unknown: withPoints.filter((a) => a.state === 'unknown').length,
      });
    },
  },
];

module.exports = { routes };
