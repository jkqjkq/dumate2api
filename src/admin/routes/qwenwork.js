// src/admin/routes/qwenwork.js - 千问办公通道：积分、状态、模型
//
// 千问办公与搭子是两套完全不同的账：它不消耗搭子的积分、不进账号池、
// 是单账号直连。所以这里的接口只服务「这条通道自己的状态」，
// 不与 points.js（搭子积分）混在一起。
const { sendJSON } = require('../router');

// 缓存：余额要打站点接口，仪表盘刷新不该每次都穿透
let cache = { at: 0, data: null };
const CACHE_MS = 15000;

/** 免费额度每天 00:00 (+08:00) 重置——重置时刻接口给了（wallet 的 valid_to） */
function resetAt(w) {
  const list = w && w.expiring ? w.expiring : [];
  for (const x of list) if (x && x.valid_to) return x.valid_to;
  return null;
}

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

/**
 * 千问办公的登录态细节（只读）。
 *
 * 与搭子不同：千问是单账号直连，登录态存在官方客户端的 auth-v2.dat 里，
 * 由 Electron safeStorage（DPAPI + AES-256-GCM）加密。管理端**只读**，
 * 写入交给客户端本身——两边各写一次会互相把对方刷掉。
 */
function loginDetail() {
  const cred = require('../../qwenwork/credentials');
  const out = {
    ok: false,
    error: '',
    // 文件位置与时间：排查「是不是客户端没登录 / 文件被清了」先看这里
    file: null,
    fileStat: null,
    machineId: '',
    // 账号信息（来自解密后的 user 对象）
    account: null,
    // token 时间线
    token: { accessExpiresAt: null, refreshExpiresAt: null, accessExpired: false, refreshExpired: false },
    // 通道就绪情况
    ready: false,
    wasm: null,
  };
  try {
    const wasmPath = require('../../qwenwork/wasm-path');
    const w = wasmPath.resolveDetailed();
    out.wasm = w ? w.version : null;
  } catch (e) { /* wasm 找不到不影响读登录态 */ }

  try {
    const path = require('path');
    const fs = require('fs');
    const file = path.join(cred.USER_DATA_DIR(), 'auth-v2.dat');
    out.file = file;
    try {
      const st = fs.statSync(file);
      out.fileStat = { size: st.size, mtime: st.mtimeMs };
    } catch (e) {
      out.error = '登录态文件不存在，请先登录千问办公客户端';
      return out;
    }

    const doc = cred.decryptAuth();
    const u = doc.user || {};
    out.account = {
      id: u.id || '',
      name: u.name || '',
      username: u.username || '',
      email: u.email || '',
      tier: u.tier || '',
      planName: u.planName || '',
      planId: u.planId || '',
      planSubscriptionActive: !!u.planSubscriptionActive,
      planNextDueDate: u.planNextDueDate || null,
      isBiz: !!u.isBiz,
      orgName: u.orgName || null,
      // 页面额度：千问按「页面数 / 月请求数 / 流量」限额，不是积分
      entitlements: u.pageEntitlements || null,
    };
    const parse = (s) => {
      const t = Date.parse(s || '');
      return Number.isFinite(t) ? t : null;
    };
    const aExp = parse(doc.expiresAt);
    const rExp = parse(doc.refreshTokenExpiresAt);
    out.token = {
      accessExpiresAt: aExp,
      refreshExpiresAt: rExp,
      accessExpired: aExp !== null && Date.now() >= aExp,
      // refresh 过期不必然立刻失败（access 还能用），但必须提前告警
      refreshExpired: rExp !== null && Date.now() >= rExp,
    };
    out.machineId = cred.machineId();
    out.ok = true;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** 积分逐笔明细：从归因历史读，按时间倒序 */
function creditRecords(limit) {
  const c = require('../../qwenwork/credits');
  const rows = c.readHistory();
  return rows
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
    .map((r) => ({
      ts: r.ts,
      req_id: r.req_id || '',
      model: r.model || '',
      ms: r.ms ?? null,
      free: r.free || 0,
      paid: r.paid || 0,
      total: r.total || 0,
      pool: r.pool || 'none',
      concurrent: !!r.concurrent,
      balance: r.balance || null,
      account: r.account || null,
    }));
}

const routes = [
  {
    method: 'GET',
    path: '/account',
    handler: async ({ req, res }) => {
      return sendJSON(res, 200, loginDetail());
    },
  },
  {
    method: 'GET',
    path: '/credits/records',
    handler: async ({ req, res }) => {
      const limit = Math.min(1000, Math.max(1, parseInt((req.url.match(/[?&]limit=(\d+)/) || [])[1] || '100', 10) || 100));
      const rows = creditRecords(limit);
      const sum = rows.reduce((s, r) => ({
        free: s.free + r.free, paid: s.paid + r.paid, total: s.total + r.total,
      }), { free: 0, paid: 0, total: 0 });
      return sendJSON(res, 200, {
        limit,
        rows,
        // 汇总只统计本次返回的窗口，界面要写清范围
        window: {
          free: Number(sum.free.toFixed(4)),
          paid: Number(sum.paid.toFixed(4)),
          total: Number(sum.total.toFixed(4)),
          requests: rows.length,
        },
      });
    },
  },
  {
    method: 'GET',
    path: '/accounts',
    handler: async ({ req, res }) => {
      // 千问是**单账号直连**：登录态只有一份（官方客户端当前登录的那个），
      // 不存在账号池。所以这里如实返回一条，而不是伪造一个可增删的列表。
      // 后续接入多账号时，这里改成读账号池文件即可，前端不用动。
      const d = loginDetail();
      const c = require('../../qwenwork/credits');
      let wallets = null;
      try {
        const w = await c.fetchWallets();
        if (w.ok) wallets = { daily: w.daily, monthly: w.monthly, longterm: w.longterm, total: w.total };
      } catch (e) { /* 余额取不到不影响账号信息 */ }
      const accounts = [];
      if (d.ok && d.account) {
        accounts.push({
          id: d.account.id,
          name: d.account.name,
          username: d.account.username,
          email: d.account.email,
          tier: d.account.tier,
          planName: d.account.planName,
          active: true,
          // 单账号模式下「是否可用」= 登录态是否还在
          usable: !d.token.refreshExpired,
          tokenExpiresAt: d.token.accessExpiresAt,
          refreshExpiresAt: d.token.refreshExpiresAt,
          refreshExpired: d.token.refreshExpired,
          wallets,
        });
      }
      return sendJSON(res, 200, {
        // 明确告诉前端这条通道的结构，界面据此决定是否显示「添加账号」
        mode: 'single',
        modeNote: '千问办公为单账号直连，登录态由官方客户端维护；多账号支持待接入。',
        count: accounts.length,
        accounts,
        error: d.ok ? '' : d.error,
      });
    },
  },
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
          // 三个池子**平级**上报，不做「免费 vs 付费」的合并——
          // 月度与长期性质不同（订阅套餐 vs 充值赠送），界面要能分开看。
          wallets: [
            { id: 'daily', label: '每日额度', kind: 'free', balance: w.daily, resetAt: resetAt(w) },
            { id: 'monthly', label: '月度积分', kind: 'paid', balance: w.monthly, resetAt: null },
            { id: 'longterm', label: '长期积分', kind: 'paid', balance: w.longterm, resetAt: null },
          ],
          // 汇总：付费 = 月度 + 长期
          free: w.daily,
          paid: w.paid,
          monthly: w.monthly,
          longterm: w.longterm,
          total: w.total,
          // 上限由「观测峰值 + 配置兜底」得出（见 credits.dailyUsageFromBalance）。
          // 接口本身不给上限，所以 calibrated=false 表示还没观测到接近满额的
          // 状态，此时消耗值可能偏小——界面要如实标注，别让人当成精确值。
          limit: w.limit,
          limitSource: w.limitSource,
          peak: w.peak,
          calibrated: w.calibrated,
          // 每日免费额度的配置上限（默认 100）。界面上「免费额度 X / 100」
          // 的分子来自接口余额、分母来自配置——接口不给分母，必须标来源。
          dailyCap: require('../../qwenwork/credits').dailyLimit(),
          // 今日全部消耗（含客户端/网页里的对话，不只经网关的）
          freeUsed: w.freeUsed,
          // 今日经本网关的消耗（另一套口径，两者不要相加）
          today: { ...todayUsage(), scope: 'gateway' },
          expiring: w.expiring || [],
          fetchedAt: w.fetchedAt,
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
