// src/traework/checkin.js - 签到 / 额度查询
//
// 三个接口都在 api.trae.cn（UgHost），请求体是空对象 {}，
// 身份全靠请求头（Authorization + X-Device-Id）。
//
// 签到是**幂等**的：已签过再 claim 不会报错，所以定时任务可以放心重跑。
const c = require('./constants');
const { ugHeaders } = require('./headers');
const authStore = require('./auth');

/**
 * 签到/额度接口都要**设备指纹匹配**，所以每次请求前先把设备三件套补齐。
 *
 * 旧的账号记录里 deviceId 是随机 hex（格式不对），ensureDevice 会按 uid
 * 重派生并落盘。不补的话签到恒定 9074。
 */
function withDevice(auth) {
  try { return authStore.ensureDevice(auth) || auth; }
  catch (e) { return auth; }
}

/**
 * 查签到状态：{ checkedIn, credits, extraCredits, enable }
 *
 * 实测返回体（2026-09-25）：
 *   { checked_in: false, credits: 150, extra_credits: 50, did_checked_in: false, enable: true }
 *
 * credits 是**签到可得的额度**（不是余额），did_checked_in 是今天是否已领。
 */
async function status(auth) {
  const r = await c.request(c.UG_HOST, c.EP_CHECKIN_STATUS, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)),
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  // 上游把结果包在 data 里，也可能是平铺——两种都认
  const d = r.data.data || r.data;
  return {
    ok: true,
    checkedIn: !!(d.checked_in ?? d.did_checked_in ?? d.checkedIn),
    credits: Number(d.credits ?? d.credit ?? 0) || 0,
    // 额外赠送（如连续签到奖励）。没有就如实给 0，不编
    extraCredits: Number(d.extra_credits ?? d.extraCredits ?? 0) || 0,
    enable: d.enable !== false,
  };
}

/**
 * 执行签到。已签过也返回 ok（幂等）。
 *
 * **HTTP 200 不代表成功**：上游在 body 里用 code 表达业务结果。
 * 只看状态码会把失败当成签到成功，界面显示「签到成功」而额度没变。
 *
 * 9074「当前参与用户太多」的真相（2026-09-25 查清）：**不是限流，是设备指纹
 * 不匹配**。原实现的 deviceId 是随机 hex，而服务端要求 15 位数字且与账号
 * 绑定。对照 smart-open/TraeWorkAssistant 后改成从 uid 确定性派生
 * （见 device.js），并补齐 sessionId / marketUserId 与客户端身份头。
 * 请求体用空对象——参考实现也是 `send_string("{}")`。
 */
const CODE_RATE_LIMITED = 9074;

async function claim(auth) {
  const r = await c.request(c.UG_HOST, c.EP_CHECKIN_CLAIM, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)),
  });
  if (r.status !== 200) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const d = (r.data && (r.data.data || r.data)) || {};
  // code 非 0 即业务失败。0 与缺省都按成功（有些返回体不带 code）
  const code = Number(d.code ?? 0) || 0;
  if (code !== 0) {
    const msg = String(d.message || `上游返回 code ${code}`);
    return {
      ok: false,
      code,
      error: code === CODE_RATE_LIMITED
        ? `${msg}（设备指纹或活动侧校验未通过；详见 checkin.js 顶部注释）`
        : msg,
      rateLimited: code === CODE_RATE_LIMITED,
    };
  }
  return {
    ok: true,
    // 有些返回体带本次获得的积分，没有就留 null（界面显示 —，不编 0）
    gained: d.credits != null ? Number(d.credits) : (d.gained != null ? Number(d.gained) : null),
    raw: d,
  };
}

/**
 * 查额度（ide_user_ent_usage）。
 *
 * 实测返回体（2026-09-25）：
 *   {
 *     is_credits_billing: true,
 *     usage_summary: { consumed_amount: 1690.06, total_amount: 5100, consumption_ratio: 0.33 },
 *     user_entitlement_pack_list: [ { display_desc:'免费', entitlement_base_info:{...} }, ... ]
 *   }
 *
 * 关键：**额度不在 credits_remain / credits_limit 这类字段里**，而在
 * usage_summary 的 total_amount（总额）与 consumed_amount（已消耗）。
 * 剩余 = 总额 − 已消耗。早先按 pack_list 里的字段求和恒得 0，界面就会
 * 显示「额度 0」——被读成「用完了」，而真相是没解析到。
 *
 * total_amount 缺失时返回 null（不补 0）：0 会被当成「额度为零」。
 */
async function usage(auth) {
  const r = await c.request(c.UG_HOST, c.EP_ENT_USAGE, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)),
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const d = r.data.data || r.data;

  let limit = null;
  let consumed = 0;
  let anyConsumed = false;
  const s = d && d.usage_summary;
  if (s && typeof s === 'object') {
    if (s.total_amount != null && Number.isFinite(Number(s.total_amount))) {
      limit = Number(s.total_amount);
    }
    if (s.consumed_amount != null && Number.isFinite(Number(s.consumed_amount))) {
      consumed = Number(s.consumed_amount);
      anyConsumed = true;
    }
  }

  // 兜底：usage_summary 缺失时退回扫额度包里的 remain/limit 字段
  // （上游结构可能变，两条路都留着，但主路径是 usage_summary）
  if (limit == null) {
    const list = Array.isArray(d) ? d : (Array.isArray(d && d.list) ? d.list
      : Array.isArray(d && d.user_entitlement_pack_list) ? d.user_entitlement_pack_list : [d]);
    let sum = 0;
    let any = false;
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const base = it.entitlement_base_info || it;
      const v = Number(base.credits_limit ?? base.creditsLimit ?? base.limit ?? base.total_amount);
      if (Number.isFinite(v)) { sum += v; any = true; }
    }
    if (any) limit = sum;
  }

  // 剩余 = 总额 − 已消耗；总额拿不到时如实返回 null
  const remain = limit == null ? null : Math.max(0, limit - consumed);
  return { ok: true, remain, limit, consumed: anyConsumed ? consumed : null, raw: d };
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
