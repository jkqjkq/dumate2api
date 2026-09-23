// src/admin/routes/usage.js - 用量统计（按模型 / 按密钥 / 按天 + 积分消耗）
//
// 数据来自两处，缺一不可：
//   1. 本地请求日志（data/requests.jsonl）——请求数、Token、模型、密钥
//   2. 上游积分记录（points/records/usage）——真实扣费
//
// 为什么扣费必须问上游：本地只知道「发了多少 token」，不知道
// 「扣了多少积分」——计费规则在上游，模型不同单价不同。日志里算不出来。
const reqlog = require('../../reqlog');
const accounts = require('../../accounts');
const web = require('../../dumate-web');
const { sendJSON } = require('../router');

// 积分记录按账号查，且需要 startAt/endAt（实测缺参数会报
// "参数错误:StartAt"）。结果按账号合并，并附上每个账号的明细。
async function pointsUsage(days) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - days * 86400;
  const list = accounts.load().accounts.filter((a) => a.enabled);
  const perAccount = [];
  let total = 0;
  let count = 0;

  for (const a of list) {
    // limit=1 就够：只取 totalCount 与 consumedPoints 这两个汇总字段，
    // 明细列表这个页面用不上，取全量只是白白多传数据
    const r = await web.api.usageRecords(a.cookie, { startAt: start, endAt: now, page: 1, limit: 1 });
    if (!r.ok) {
      perAccount.push({ id: a.id, name: a.name, ok: false, error: r.error });
      continue;
    }
    const consumed = Number(r.consumed_points || 0);
    const cnt = Number(r.total_count || 0);
    total += consumed;
    count += cnt;
    perAccount.push({ id: a.id, name: a.name, ok: true, consumed_points: consumed, count: cnt });
  }

  return { total_consumed: Math.round(total * 100) / 100, total_records: count, accounts: perAccount };
}

// 今日消耗单独取（窗口不同，不能从上面的结果推算）
async function pointsTodayUsage() {
  const now = Math.floor(Date.now() / 1000);
  const start = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const list = accounts.load().accounts.filter((a) => a.enabled);
  let total = 0;
  let count = 0;

  for (const a of list) {
    const r = await web.api.usageRecords(a.cookie, { startAt: start, endAt: now, page: 1, limit: 1 });
    if (r.ok) {
      total += Number(r.consumed_points || 0);
      count += Number(r.total_count || 0);
    }
  }
  return { consumed: Math.round(total * 100) / 100, records: count };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function loadRows(days) {
  const since = Date.now() - days * 86400000;
  const { rows } = reqlog.read({ limit: 0, filter: (r) => r.ts >= since });
  return rows;
}

// 把一组请求聚合成一行统计
function bucket(rows, keyFn, labelKey) {
  const map = {};
  for (const r of rows) {
    const k = keyFn(r) || '(未知)';
    if (!map[k]) {
      map[k] = { [labelKey]: k, requests: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0, failed: 0, total_ms: 0 };
    }
    const b = map[k];
    b.requests++;
    b.total_tokens += r.total_tokens || 0;
    b.input_tokens += r.input_tokens || 0;
    b.output_tokens += r.output_tokens || 0;
    b.total_ms += r.ms || 0;
    if (r.status >= 400 || r.status === 0) b.failed++;
  }
  return Object.values(map).map((b) => ({ ...b, avg_ms: b.requests ? Math.round(b.total_ms / b.requests) : 0 }));
}

const routes = [
  {
    // 页面主接口：一次给全顶部卡片 + 三张表
    method: 'GET',
    path: '/overview',
    handler: async ({ res, req }) => {
      const days = clampInt((req.url.match(/[?&]days=(\d+)/) || [])[1], 30, 1, 90);
      const rows = loadRows(days);
      const today = dayKey(Date.now());
      const todayRows = rows.filter((r) => dayKey(r.ts) === today);
      // 本周 = 最近 7 天（含今天）
      const weekStart = Date.now() - 7 * 86400000;
      const weekRows = rows.filter((r) => r.ts >= weekStart);

      const sum = (list) => ({
        requests: list.length,
        tokens: list.reduce((s, r) => s + (r.total_tokens || 0), 0),
        failed: list.filter((r) => r.status >= 400 || r.status === 0).length,
      });

      // 积分消耗问上游（本地算不出扣费）
      const [pointsAll, todayPoints] = await Promise.all([
        pointsUsage(days),
        pointsTodayUsage(),
      ]);

      // 今日单独算一套更细的指标：顶部卡片要回答「今天跑得怎么样」，
      // 只有请求数与 token 不够——还得知道成功率、快慢、哪些模型在用。
      const okRows = todayRows.filter((r) => r.status >= 200 && r.status < 400);
      const doneRows = todayRows.filter((r) => r.ms);
      const ftRows = todayRows.filter((r) => typeof r.first_token_ms === 'number');

      const todayDetail = {
        ...sum(todayRows),
        success_rate: todayRows.length
          ? Math.round((okRows.length / todayRows.length) * 1000) / 10
          : null,
        avg_ms: doneRows.length
          ? Math.round(doneRows.reduce((s, r) => s + r.ms, 0) / doneRows.length)
          : null,
        // 首字延迟只统计有值的记录——老日志没有这个字段，
        // 把它们当成 0 会把平均值拉低并给出错误的结论
        avg_first_token_ms: ftRows.length
          ? Math.round(ftRows.reduce((s, r) => s + r.first_token_ms, 0) / ftRows.length)
          : null,
        first_token_samples: ftRows.length,
        input_tokens: todayRows.reduce((s, r) => s + (r.input_tokens || 0), 0),
        output_tokens: todayRows.reduce((s, r) => s + (r.output_tokens || 0), 0),
        stream_count: todayRows.filter((r) => r.stream).length,
        // 今日用量按模型拆分，卡片上只标主力
        models: Object.entries(
          todayRows.reduce((m, r) => {
            const k = r.model || '(未知)';
            m[k] = (m[k] || 0) + (r.total_tokens || 0);
            return m;
          }, {})
        ).map(([model, tokens]) => ({ model, tokens }))
          .sort((a, b) => b.tokens - a.tokens),
        consumed_points: todayPoints.consumed,
        point_records: todayPoints.records,
      };

      // 按天：补齐没有请求的日期，否则折线会把空档连成直线
      const byDay = {};
      for (const r of rows) {
        const k = dayKey(r.ts);
        if (!byDay[k]) byDay[k] = { day: k, requests: 0, total_tokens: 0, failed: 0 };
        byDay[k].requests++;
        byDay[k].total_tokens += r.total_tokens || 0;
        if (r.status >= 400 || r.status === 0) byDay[k].failed++;
      }
      const daily = [];
      for (let i = days - 1; i >= 0; i--) {
        const k = dayKey(Date.now() - i * 86400000);
        daily.push(byDay[k] || { day: k, requests: 0, total_tokens: 0, failed: 0 });
      }

      const byModel = bucket(rows, (r) => r.model, 'model')
        .sort((a, b) => b.total_tokens - a.total_tokens);
      const byKey = bucket(rows, (r) => r.key || (r.key_id ? `key-${r.key_id}` : '未使用密钥'), 'name')
        .sort((a, b) => b.total_tokens - a.total_tokens);

      // 活跃密钥：有实际请求的密钥数量。日志里 key_id=0 表示未启用鉴权，
      // 那种情况下没有「密钥」可言，如实返回 0 而不是编一个。
      const activeKeys = new Set(rows.filter((r) => r.key_id).map((r) => r.key_id)).size;

      // 按通道聚合。关键点：**channel 字段上线前的历史记录归入「未标注」**，
      // 不并入任一通道——默认成 dumate 就是在编数据，会让搭子的历史数字
      // 凭空变大，而用户无从察觉。
      const CH_LABEL = { dumate: '百度搭子', qwenwork: '千问办公' };
      const chMap = {};
      for (const r of rows) {
        const id = r.channel || 'untagged';
        if (!chMap[id]) chMap[id] = { id, label: CH_LABEL[id] || (id === 'untagged' ? '未标注' : id), requests: 0, total_tokens: 0, failed: 0, avg_ms: 0, _msSum: 0 };
        const c = chMap[id];
        c.requests++;
        c.total_tokens += r.total_tokens || 0;
        c._msSum += r.ms || 0;
        if (r.status >= 400 || r.status === 0) c.failed++;
      }
      const byChannel = Object.values(chMap)
        .map((c) => ({ ...c, avg_ms: c.requests ? Math.round(c._msSum / c.requests) : 0, _msSum: undefined }))
        .sort((a, b) => b.requests - a.requests);

      // 首字延迟按通道分开：千问首帧实测 6.7s，混进搭子的均值里会让
      // 「平均首字延迟」既偏高又无法归因。
      for (const c of byChannel) {
        const sub = rows.filter((r) => (r.channel || 'untagged') === c.id && r.first_token_ms != null);
        c.first_token_samples = sub.length;
        c.avg_first_token_ms = sub.length
          ? Math.round(sub.reduce((a, r) => a + r.first_token_ms, 0) / sub.length)
          : null;
      }

      return sendJSON(res, 200, {
        days,
        cards: {
          today: todayDetail,
          week: sum(weekRows),
          consumed: pointsAll.total_consumed,
          consumed_records: pointsAll.total_records,
          active_keys: activeKeys,
          // 主力模型 = 窗口内 token 消耗最多的那个
          top_model: byModel.length ? byModel[0].model : null,
        },
        daily,
        by_model: byModel,
        by_key: byKey,
        by_channel: byChannel,
        // 各账号的积分消耗，供「按账号」视图
        points_by_account: pointsAll.accounts,
        // 说明扣费口径，避免与本地 token 统计混淆
        note: 'Token 与请求数来自本地网关日志；积分消耗来自上游计费记录，两者口径不同（不同模型单价不同）。',
      });
    },
  },
];

module.exports = { routes, pointsUsage, pointsTodayUsage };
