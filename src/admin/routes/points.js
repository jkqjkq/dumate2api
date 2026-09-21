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
        expire_at: p.expireDate ? p.expireDate * 1000 : null,
        status: p.status || '',
      };
    });

  // 最近到期的未用完包：这是「即将过期」提示的依据，全量 89 个包里
  // 绝大多数已用尽，只有未用尽的才值得提醒
  const expiring = packages
    .filter((p) => p.left > 0 && p.expire_at)
    .sort((a, b) => a.expire_at - b.expire_at)
    .slice(0, 5);

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
    handler: ({ res }) => {
      const accounts = listAccounts();
      if (accounts === null) return sendJSON(res, 502, { error: 'auth.json not readable' });
      return sendJSON(res, 200, {
        accounts,
        total: accounts.length,
        active: accounts.filter((a) => a.state === 'active').length,
        stale: accounts.filter((a) => a.state === 'stale').length,
        unknown: accounts.filter((a) => a.state === 'unknown').length,
      });
    },
  },
];

module.exports = { routes };
