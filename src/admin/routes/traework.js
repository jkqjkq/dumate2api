// src/admin/routes/traework.js - TRAE Work 通道的管理接口
//
// 与千问路由（qwenwork.js）的关键差异：
//   千问是「单账号、只读客户端登录态」——账号不能增删，界面只能展示。
//   TRAE Work 的凭证是**我们自己持有的**，所以这里支持增删与手动登录。
//
// 三个接口组：账号管理、签到、登录。
const { sendJSON } = require('../router');
const authStore = require('../../traework/auth');
const checkin = require('../../traework/checkin');
const login = require('../../traework/login');
const models = require('../../traework/models');
const tw = require('../../traework');

const routes = [
  {
    // 通道状态 + 账号列表（脱敏：refreshToken 只给尾部 6 位）
    method: 'GET',
    path: '/status',
    handler: async ({ res }) => {
      let st = { ready: false, error: '' };
      try { st = tw.status(); } catch (e) { st = { ready: false, error: e.message }; }
      return sendJSON(res, 200, {
        ready: st.ready,
        error: st.error || '',
        accounts: st.accounts || 0,
        // 明确告诉前端这条通道的结构：可增删，与千问的 single 模式不同
        mode: 'multi',
        modeNote: 'TRAE Work 的凭证由本项目自行 OAuth 换取并保存，可多账号并存、可增删。',
        rows: authStore.list(),
      });
    },
  },
  {
    // 模型表（只读，上游下发）。带消耗倍率、上下文窗口、会员折扣。
    // ?visible=1 只看客户端可见的模型（默认全部返回，隐藏的多是内部模型，
    // 排查「为什么某个名字调不通」时需要看到它们）。
    method: 'GET',
    path: '/models',
    handler: async ({ res, req }) => {
      const onlyVisible = /[?&]visible=1/.test(req.url || '');
      const force = /[?&]refresh=1/.test(req.url || '');
      let out = { ok: false, error: '', models: [], fetchedAt: 0 };
      try {
        out = await models.fetchModels({ force });
      } catch (e) {
        out = { ok: false, error: e.message, models: [], fetchedAt: 0 };
      }
      let list = out.models || [];
      if (onlyVisible) list = list.filter((m) => m.visible);
      return sendJSON(res, 200, {
        models: list,
        total: (out.models || []).length,
        // 取不到时如实报错，前端显示错误而不是一张空表
        error: out.error || '',
        fetchedAt: out.fetchedAt || 0,
        // 倍率的单位与来源写清楚：接口给的是相对倍率，不是积分绝对值
        rateNote: '倍率是相对值（接口字段 consumption_rate.rate），实际扣费 = 倍率 × 用量；折扣未命中时按原价扣。',
      });
    },
  },
  {
    // 全部账号的签到状态与额度。不落盘——只读快照，避免刷新动作本身触发签到
    method: 'GET',
    path: '/credits',
    handler: async ({ res }) => {
      const list = authStore.findUsable();
      const rows = [];
      for (const a of list) {
        const st = await checkin.status(a);
        const u = await checkin.usage(a);
        rows.push({
          id: a.id,
          nickname: a.nickname || '',
          uid: a.uid || '',
          credits: a.credits == null ? null : a.credits,
          checkedIn: st.ok ? st.checkedIn : null,
          // 额度接口的实时值。remain/limit 取不到时给 null——
          // 补 0 会被读成「额度用完了」，而真相是没解析到
          remain: u.ok ? u.remain : null,
          limit: u.ok ? u.limit : null,
          consumed: u.ok ? u.consumed : null,
          // 签到可得的额度（不是余额），来自 status 接口
          checkinCredits: st.ok ? st.credits : null,
          checkinExtra: st.ok ? st.extraCredits : null,
          lastCheckin: a.lastCheckin || null,
          // error 只表示「这次状态查询失败」——别把上次签到尝试的失败消息
          // 塞进来。两者是不同的东西：前者是「查不到」，后者是「查到了，
          // 但上一次签到被上游拒了」。混在一起时前端只能显示「查询失败」，
          // 把「今天还没签」这个已经查到的事实盖掉了（真踩过）。
          // 上次签到的结果由 /status 的 lastError 单独报，账号卡上已有告警位。
          error: st.ok ? '' : st.error,
        });
      }
      return sendJSON(res, 200, { count: rows.length, rows });
    },
  },
  {
    // 手动签到：幂等，已签的自动跳过
    method: 'POST',
    path: '/checkin',
    handler: async ({ res, body }) => {
      const id = body && body.id;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.findUsable();
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号' });
      const out = [];
      for (const a of list) {
        const r = await checkin.checkinAndSave(a, authStore);
        out.push({ id: a.id, nickname: a.nickname || a.uid || '', ...r });
      }
      return sendJSON(res, 200, { ok: true, results: out });
    },
  },
  {
    // 生成一次登录所需的设备标识 + 授权链接。
    // 前端拿到后开浏览器；用户把回调地址粘回来，再调 /login/callback。
    method: 'POST',
    path: '/login/url',
    handler: async ({ res }) => {
      const ids = login.newDeviceIds();
      return sendJSON(res, 200, {
        ok: true,
        url: login.buildAuthUrl(ids),
        deviceId: ids.deviceId,
        machineId: ids.machineId,
        // 提示：回调地址要原样粘回来
        hint: '浏览器登录后跳到 127.0.0.1:18080（打不开是正常的），复制地址栏完整 URL。',
      });
    },
  },
  {
    method: 'POST',
    path: '/login/callback',
    handler: async ({ res, body }) => {
      const cb = body && body.callback;
      const deviceId = body && body.deviceId;
      const machineId = body && body.machineId;
      if (!cb) return sendJSON(res, 400, { error: '缺少 callback' });
      if (!deviceId || !machineId) {
        return sendJSON(res, 400, { error: '缺少 deviceId / machineId（需先调 /login/url 拿到）' });
      }
      const parsed = login.parseCallback(cb);
      if (!parsed.refreshToken) {
        return sendJSON(res, 400, { error: '回调里没有 refreshToken，检查是否粘了完整地址' });
      }
      const r = await login.exchangeAndSave({
        refreshToken: parsed.refreshToken,
        deviceId, machineId,
        uid: parsed.uid, nickname: parsed.nickname,
      });
      if (!r.ok) return sendJSON(res, 200, { ok: false, error: r.error });
      return sendJSON(res, 200, { ok: true, account: r.account });
    },
  },
  {
    // 回填手机号。
    //
    // TRAE 的 GetUserInfo 已 401，拿不到官方身份字段，昵称是唯一线索。
    // 但「昵称 = 用户 + 手机号」这个假设**实测不成立**（本机这个号是
    // 「用户23062830688」，以 2 开头，不是手机号），所以这里只在昵称
    // 严格匹配标准手机号时才填，抽不到就不给——不猜、不凑。
    //
    // 这条**不发任何网络请求**，只重扫一遍已有的 nickname。
    method: 'POST',
    path: '/accounts/refresh-phone',
    handler: async ({ res, body }) => {
      const id = body && body.id;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.findUsable();
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号' });
      const out = [];
      for (const a of list) {
        const p = authStore.phoneFromNickname(a.nickname);
        if (p) {
          authStore.patch(a.id, { phone: p, phoneSource: 'inferred-nickname' });
          out.push({ id: a.id, name: a.nickname || '', ok: true, phone: authStore.maskPhone(p) });
        } else {
          out.push({
            id: a.id, name: a.nickname || '', ok: false,
            error: '昵称不是「用户+手机号」格式，无法推断',
          });
        }
      }
      return sendJSON(res, 200, {
        ok: true, results: out,
        // 如实说明：TRAE 侧拿不到官方手机号，能填上纯属昵称恰好合格式
        note: 'TRAE Work 无官方手机号接口（GetUserInfo 已 401）。仅当昵称形如「用户13800138000」时才能取到，否则显示「手机号未知」。',
      });
    },
  },
  {
    method: 'DELETE',
    path: '/accounts/:id',
    handler: async ({ res, params }) => {
      const ok = authStore.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: '账号不存在' });
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    method: 'PATCH',
    path: '/accounts/:id',
    handler: async ({ res, params, body }) => {
      const fields = {};
      if (body && body.enabled !== undefined) fields.enabled = !!body.enabled;
      const a = authStore.patch(params[0], fields);
      if (!a) return sendJSON(res, 404, { error: '账号不存在' });
      return sendJSON(res, 200, { ok: true, account: authStore.list().find((x) => x.id === a.id) });
    },
  },
];

module.exports = { routes };
