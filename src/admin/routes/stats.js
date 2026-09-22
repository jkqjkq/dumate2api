// src/admin/routes/stats.js - 用量统计（数据源：data/requests.jsonl）
const reqlog = require('../../reqlog');
const { sendJSON } = require('../router');

// 解析并钳制查询参数。下界同样重要：days=0 会让窗口从「现在」开始、
// 结果恒为空，界面显示「还没有请求记录」，看起来像没有数据而不是参数错。
function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function dayKey(ts) {
  const d = new Date(ts);
  // 本地时区的 YYYY-MM-DD：用 UTC 会把晚上的请求算到第二天
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load(days = 30) {
  const since = Date.now() - days * 86400000;
  const { rows } = reqlog.read({ limit: 0, filter: (r) => r.ts >= since });
  return rows;
}

function summarize(rows) {
  const ok = rows.filter((r) => r.status >= 200 && r.status < 400);
  return {
    requests: rows.length,
    ok: ok.length,
    failed: rows.length - ok.length,
    input_tokens: rows.reduce((a, r) => a + (r.input_tokens || 0), 0),
    output_tokens: rows.reduce((a, r) => a + (r.output_tokens || 0), 0),
    total_tokens: rows.reduce((a, r) => a + (r.total_tokens || 0), 0),
    avg_ms: rows.length ? Math.round(rows.reduce((a, r) => a + (r.ms || 0), 0) / rows.length) : 0,
  };
}

const routes = [
  {
    method: 'GET',
    path: '/summary',
    handler: ({ res }) => {
      const today = dayKey(Date.now());
      const all = load(30);
      const todayRows = all.filter((r) => dayKey(r.ts) === today);
      return sendJSON(res, 200, {
        today: summarize(todayRows),
        days: 30,
        total: summarize(all),
      });
    },
  },
  {
    method: 'GET',
    path: '/daily',
    handler: ({ res, req }) => {
      const days = clampInt((req.url.match(/[?&]days=(\d+)/) || [])[1], 14, 1, 90);
      const rows = load(days);
      const buckets = {};
      for (const r of rows) {
        const k = dayKey(r.ts);
        if (!buckets[k]) buckets[k] = { day: k, requests: 0, total_tokens: 0, failed: 0 };
        buckets[k].requests++;
        buckets[k].total_tokens += r.total_tokens || 0;
        if (r.status >= 400 || r.status === 0) buckets[k].failed++;
      }
      // 补齐没有请求的日期，否则折线图会把空档连成直线
      const out = [];
      for (let i = days - 1; i >= 0; i--) {
        const k = dayKey(Date.now() - i * 86400000);
        out.push(buckets[k] || { day: k, requests: 0, total_tokens: 0, failed: 0 });
      }
      return sendJSON(res, 200, { days, rows: out });
    },
  },
  {
    method: 'GET',
    path: '/by-model',
    handler: ({ res, req }) => {
      const days = clampInt((req.url.match(/[?&]days=(\d+)/) || [])[1], 30, 1, 90);
      const buckets = {};
      for (const r of load(days)) {
        const k = r.model || '(未知)';
        if (!buckets[k]) buckets[k] = { model: k, requests: 0, total_tokens: 0, failed: 0 };
        buckets[k].requests++;
        buckets[k].total_tokens += r.total_tokens || 0;
        if (r.status >= 400 || r.status === 0) buckets[k].failed++;
      }
      const rows = Object.values(buckets).sort((a, b) => b.total_tokens - a.total_tokens);
      return sendJSON(res, 200, { days, rows });
    },
  },
  {
    method: 'GET',
    path: '/by-path',
    handler: ({ res, req }) => {
      const days = clampInt((req.url.match(/[?&]days=(\d+)/) || [])[1], 30, 1, 90);
      const buckets = {};
      for (const r of load(days)) {
        const k = r.path || '(未知)';
        if (!buckets[k]) buckets[k] = { path: k, requests: 0, total_tokens: 0, failed: 0 };
        buckets[k].requests++;
        buckets[k].total_tokens += r.total_tokens || 0;
        if (r.status >= 400 || r.status === 0) buckets[k].failed++;
      }
      const rows = Object.values(buckets).sort((a, b) => b.requests - a.requests);
      return sendJSON(res, 200, { days, rows });
    },
  },
  {
    method: 'GET',
    path: '/recent',
    handler: ({ res, req }) => {
      const limit = clampInt((req.url.match(/[?&]limit=(\d+)/) || [])[1], 50, 1, 200);
      const status = (req.url.match(/[?&]status=(\d+)/) || [])[1];
      const filter = status ? (r) => String(r.status) === status : null;
      const { rows, total } = reqlog.read({ limit, filter });
      return sendJSON(res, 200, { rows, total });
    },
  },
];

module.exports = { routes };
