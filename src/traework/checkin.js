// src/traework/checkin.js - 签到 / 额度查询
//
// 三个接口都在 api.trae.cn（UgHost），请求体是空对象 {}，
// 身份全靠请求头（Authorization + X-Device-Id）。
//
// 签到是**幂等**的：已签过再 claim 不会报错，所以定时任务可以放心重跑。
const c = require('./constants');
const { ugHeaders } = require('./headers');

/** 查签到状态：{ checkedIn, credits, enable } */
async function status(auth) {
  const r = await c.request(c.UG_HOST, c.EP_CHECKIN_STATUS, {
    method: 'POST', body: {}, headers: ugHeaders(auth),
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  // 上游把结果包在 data 里，也可能是平铺——两种都认
  const d = r.data.data || r.data;
  return {
    ok: true,
    checkedIn: !!(d.checked_in ?? d.checkedIn),
    credits: Number(d.credits ?? d.credit ?? 0) || 0,
    enable: d.enable !== false,
  };
}

/** 执行签到。已签过也返回 ok（幂等） */
async function claim(auth) {
  const r = await c.request(c.UG_HOST, c.EP_CHECKIN_CLAIM, {
    method: 'POST', body: {}, headers: ugHeaders(auth),
  });
  if (r.status !== 200) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const d = (r.data && (r.data.data || r.data)) || {};
  return {
    ok: true,
    // 有些返回体带本次获得的积分，没有就留 null（界面显示 —，不编 0）
    gained: d.credits != null ? Number(d.credits) : (d.gained != null ? Number(d.gained) : null),
    raw: d,
  };
}

/** 查额度（ide_user_ent_usage，取 credits_limit 之和） */
async function usage(auth) {
  const r = await c.request(c.UG_HOST, c.EP_ENT_USAGE, {
    method: 'POST', body: {}, headers: ugHeaders(auth),
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const d = r.data.data || r.data;
  // 结构可能是数组（多条额度包）或对象，两种都兜住
  const list = Array.isArray(d) ? d : (Array.isArray(d.list) ? d.list : [d]);
  let remain = 0;
  let limit = 0;
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    remain += Number(it.credits_remain ?? it.creditsRemain ?? it.remain ?? 0) || 0;
    limit += Number(it.credits_limit ?? it.creditsLimit ?? it.limit ?? 0) || 0;
  }
  return { ok: true, remain, limit, raw: d };
}

/** 签到并回写账号（含额度刷新）。供 task-runner 调用 */
async function checkinAndSave(auth, authStore) {
  const st = await status(auth);
  if (!st.ok) return { ok: false, error: st.error, stage: 'status' };
  if (st.checkedIn) {
    const u = await usage(auth);
    const fields = { lastCheckin: auth.lastCheckin || null, lastError: '' };
    if (u.ok) fields.credits = u.remain;
    authStore.patch(auth.id, fields);
    return { ok: true, already: true, credits: u.ok ? u.remain : null };
  }
  const cl = await claim(auth);
  if (!cl.ok) {
    authStore.patch(auth.id, { lastError: cl.error });
    return { ok: false, error: cl.error, stage: 'claim' };
  }
  const u = await usage(auth);
  authStore.patch(auth.id, {
    lastCheckin: Date.now(),
    lastError: '',
    ...(u.ok ? { credits: u.remain } : {}),
  });
  return { ok: true, already: false, gained: cl.gained, credits: u.ok ? u.remain : null };
}

module.exports = { status, claim, usage, checkinAndSave };
