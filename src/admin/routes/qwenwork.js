// src/admin/routes/qwenwork.js - 千问办公通道：积分、状态、模型
//
// 千问办公与搭子是两套完全不同的账：它不消耗搭子的积分、不进账号池、
// 是单账号直连。所以这里的接口只服务「这条通道自己的状态」，
// 不与 points.js（搭子积分）混在一起。
const { sendJSON } = require('../router');

// 缓存：余额要打站点接口，仪表盘刷新不该每次都穿透
let cache = { at: 0, data: null };
const CACHE_MS = 15000;

async function credits() {
  const c = require('../../qwenwork/credits');
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const w = await c.fetchWallets();
  cache = { at: Date.now(), data: w };
  return w;
}

/** 按天聚合归因历史。只聚合有 channel 概念之后的数据 */
function dailyUsage(days) {
  const c = require('../../qwenwork/credits');
  const rows = c.readHistory();
  const since = Date.now() - days * 86400000;
  const byDay = new Map();
  for (const r of rows) {
    if (!r || r.ts < since) continue;
    const d = new Date(r.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = byDay.get(key) || { day: key, free: 0, paid: 0, total: 0, requests: 0, concurrent: 0 };
    cur.free += r.free || 0;
    cur.paid += r.paid || 0;
    cur.total += r.total || 0;
    cur.requests += 1;
    if (r.concurrent) cur.concurrent += 1;
    byDay.set(key, cur);
  }
  // 补齐没有请求的日期，否则折线图会把间隔压掉
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = byDay.get(key) || { day: key, free: 0, paid: 0, total: 0, requests: 0, concurrent: 0 };
    out.push({
      day: key,
      free: Number(cur.free.toFixed(4)),
      paid: Number(cur.paid.toFixed(4)),
      total: Number(cur.total.toFixed(4)),
      requests: cur.requests,
      concurrent: cur.concurrent,
    });
  }
  return out;
}

function todayUsage() {
  const c = require('../../qwenwork/credits');
  const rows = c.readHistory();
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let free = 0; let paid = 0; let n = 0;
  for (const r of rows) {
    if (!r) continue;
    const rd = new Date(r.ts);
    const key = `${rd.getFullYear()}-${String(rd.getMonth() + 1).padStart(2, '0')}-${String(rd.getDate()).padStart(2, '0')}`;
    if (key !== today) continue;
    free += r.free || 0;
    paid += r.paid || 0;
    n += 1;
  }
  return { free: Number(free.toFixed(4)), paid: Number(paid.toFixed(4)), total: Number((free + paid).toFixed(4)), requests: n };
}

const routes = [
  {
    method: 'GET',
    path: '/status',
    handler: async ({ req, res }) => {
      let st = { ready: false, error: '未加载' };
      let acct = {};
      try {
        const qw = require('../../qwenwork');
        st = qw.status();
        const cred = require('../../qwenwork/credentials');
        const doc = cred.decryptAuth();
        const u = doc.user || {};
        acct = {
          account: u.name || '',
          tier: u.tier || '',
          planId: u.planId || '',
          tokenExpiresAt: doc.expiresAt || null,
          refreshExpiresAt: doc.refreshTokenExpiresAt || null,
          // refresh token 有独立有效期且比 access token 短命，过期后必须
          // 重新登录客户端。提前告警，而不是等请求失败才发现。
          refreshExpired: (() => {
            const t = Date.parse(doc.refreshTokenExpiresAt || '');
            return Number.isFinite(t) ? Date.now() >= t : false;
          })(),
          tokenExpired: (() => {
            const t = Date.parse(doc.expiresAt || '');
            return Number.isFinite(t) ? Date.now() >= t : false;
          })(),
        };
      } catch (e) {
        st = { ready: false, error: e.message };
      }
      // token 绝不外传：只给到期时间与账号名
      return sendJSON(res, 200, {
        ready: st.ready,
        wasm: st.wasm ? st.wasm.version : null,
        loggedIn: !!st.loggedIn,
        error: st.error || '',
        ...acct,
      });
    },
  },
  {
    method: 'GET',
    path: '/credits',
    handler: async ({ req, res }) => {
      try {
        const w = await credits();
        return sendJSON(res, 200, {
          ok: w.ok,
          error: w.error || '',
          // 三池分开报：daily 是免费额度（每天重置），monthly/longterm 是付费
          free: w.daily,
          paid: w.paid,
          monthly: w.monthly,
          longterm: w.longterm,
          total: w.total,
          // 上限来自配置而非接口，前端必须标注来源
          limit: w.limit,
          limitSource: 'config',
          freeUsed: w.freeUsed,
          expiring: w.expiring || [],
          fetchedAt: w.fetchedAt,
          today: todayUsage(),
        });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    },
  },
  {
    method: 'GET',
    path: '/credits/daily',
    handler: async ({ req, res }) => {
      const days = Math.min(90, Math.max(1, parseInt((req.url.match(/[?&]days=(\d+)/) || [])[1] || '14', 10) || 14));
      return sendJSON(res, 200, { days, rows: dailyUsage(days) });
    },
  },
  {
    method: 'GET',
    path: '/models',
    handler: async ({ req, res }) => {
      let models = [];
      let error = '';
      try {
        const qw = require('../../qwenwork');
        const keys = await qw.listModels();
        // 中文名来自上游 display_name（pro→高级 / flash→标准）。
        // 硬编码一份必然过期——1.1.0 实测模型表已与旧版不同。
        const names = { pro: '高级', flash: '标准', 'qwen3.8-max-preview': 'Qwen3.8-Max' };
        models = keys.map((k) => ({ id: k, name: names[k] || k, prefixed: `qwen/${k}` }));
      } catch (e) {
        error = e.message;
      }
      return sendJSON(res, 200, { models, error });
    },
  },
];

module.exports = { routes };
