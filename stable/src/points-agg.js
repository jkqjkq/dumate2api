// src/points-agg.js - 额度包聚合（按来源 / 按发放日 / 临期 / 已过期未用完）
//
// 本地后端（桌面凭证）与网页账号（cookie 凭证）查到的是同一份额度包结构，
// 但字段来源不同：前者从 quota_overview 直接算，后者经由 dumate-web 已算好
// left。两份都要得出「按来源统计」「每日发放」「即将过期」这些派生视图，
// 各写一份就会出现两边口径不一致（比如一边按到期日、一边按发放日判断
// 「还在不在发」），所以收敛到这里。
//
// 输入包对象至少要有 total / used / left / granted_at / expire_at。
// 缺字段按 0 / null 处理，不抛错——上游偶尔会给出不带日期的包。

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalize(p) {
  const total = num(p.total);
  const used = num(p.used);
  return {
    kind: p.kind || '',
    package_type: p.package_type || '',
    source: p.source || '',
    total,
    used,
    // 上游给的 left 已经是 total-used 的结果，但两边算法要一致，
    // 这里统一重算，避免一边传了负值另一边没有
    left: Math.max(0, total - used),
    granted_at: p.granted_at || null,
    expire_at: p.expire_at || null,
    status: p.status || '',
  };
}

// 按来源聚合。积分明细里最有信息量的一层：能看出「每天自动发的登录奖励」
// 和「成长计划奖励」各占多少、是否还在持续发放。
//
// 「还在不在发」必须看发放日（granted_at）而不是到期日——到期日只说明
// 这批额度什么时候作废，说明不了发放节奏。
function aggregateBySource(packages) {
  const bySource = {};
  for (const p of packages) {
    const k = p.source || '(未知来源)';
    if (!bySource[k]) {
      bySource[k] = {
        source: k, count: 0, total: 0, used: 0, left: 0,
        first_at: null, last_at: null, active_days: new Set(),
      };
    }
    const s = bySource[k];
    s.count++;
    s.total += p.total;
    s.used += p.used;
    s.left += p.left;
    const day = p.granted_at ? new Date(p.granted_at).toISOString().slice(0, 10) : null;
    if (day) {
      s.active_days.add(day);
      if (!s.first_at || p.granted_at < s.first_at) s.first_at = p.granted_at;
      if (!s.last_at || p.granted_at > s.last_at) s.last_at = p.granted_at;
    }
  }
  return Object.values(bySource).map((s) => ({
    ...s,
    active_days: s.active_days.size,
    days_since_last: s.last_at ? Math.floor((Date.now() - s.last_at) / 86400000) : null,
  })).sort((a, b) => b.total - a.total);
}

// 按发放日聚合，给出每日新增额度曲线（与「每日消耗」是两回事）
function aggregateByDay(packages) {
  const byDay = {};
  for (const p of packages) {
    if (!p.granted_at) continue;
    const k = new Date(p.granted_at).toISOString().slice(0, 10);
    if (!byDay[k]) byDay[k] = { day: k, granted: 0, used: 0, count: 0 };
    byDay[k].granted += p.total;
    byDay[k].used += p.used;
    byDay[k].count++;
  }
  return Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1));
}

// 把一批额度包派生出界面需要的全部视图
function aggregate(rawPackages, extra = {}) {
  const packages = (rawPackages || []).map(normalize);
  const now = Date.now();

  // 最近到期的未用完包：这是「即将过期」提示的依据，全量包里绝大多数
  // 已用尽，只有未用尽的才值得提醒
  const expiring = packages
    .filter((p) => p.left > 0 && p.expire_at)
    .sort((a, b) => a.expire_at - b.expire_at)
    .slice(0, 10);

  // 已过期但还有余额的包：这部分额度实际已经用不上了，单独列出来
  // 说明「总额度」里有多少是已经失效的
  const expiredUnused = packages.filter((p) => p.left > 0 && p.expire_at && p.expire_at < now);

  return {
    packages,
    expiring,
    expired_unused: expiredUnused,
    sources: aggregateBySource(packages),
    daily_grant: aggregateByDay(packages),
    ...extra,
  };
}

module.exports = { aggregate, normalize };
