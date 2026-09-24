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
          // 额度接口给的剩余值（与落盘的 credits 可能不同，取实时值）
          remain: u.ok ? u.remain : null,
          limit: u.ok ? u.limit : null,
          lastCheckin: a.lastCheckin || null,
          error: st.ok ? (a.lastError || '') : st.error,
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
