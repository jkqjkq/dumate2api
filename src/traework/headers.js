// src/traework/headers.js - 三套请求头
//
// TRAE 的三个 host 各有各的头，混用会失败（实测开源实现里也是分开写的）：
//   SOLOHeaders  对话 / 模型列表 —— 14 个头，最复杂
//   UgHeaders    签到 / 额度     —— 只需 region + device-id
//   OAuthHeaders 换票 / 用户信息 —— 几乎裸请求
//
// 关键：**token 走 Cloud-IDE-JWT 前缀**，且对话路径要同时带
// X-Cloudide-Token 与 X-Ide-Token 两个头（上游两个都读）。
const c = require('./constants');

/** 对话 / 模型列表。auth 需含 accessToken / uid / machineId / deviceId */
function soloHeaders(auth, stream = false) {
  const at = (auth && auth.accessToken) || '';
  const h = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': c.USER_AGENT,
    Authorization: `Cloud-IDE-JWT ${at}`,
    // 两个都要带：上游对这两条路径的取值不完全一致，缺一个可能 401
    'X-Cloudide-Token': at,
    'X-Ide-Token': at,
    'X-App-Id': c.APP_ID,
    'X-App-Version': 'default',
    'X-Ide-Version': c.IDE_VERSION,
    'X-Ide-Version-Code': c.IDE_VERSION_CODE,
    'X-App-Version-Code': c.IDE_VERSION_CODE,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': c.OS_VERSION,
    'X-Device-Brand': c.DEVICE_BRAND,
    'Request-Traffic-Type': 'prod',
  };
  if (auth && auth.uid) h['X-Uid'] = auth.uid;
  if (auth && auth.machineId) h['X-Machine-Id'] = auth.machineId;
  if (auth && auth.deviceId) h['X-Device-Id'] = auth.deviceId;
  return h;
}

/** 签到 / 额度（api.trae.cn） */
function ugHeaders(auth) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': c.USER_AGENT,
    Authorization: `Cloud-IDE-JWT ${(auth && auth.accessToken) || ''}`,
    'X-User-Region': 'CN',
  };
  if (auth && auth.deviceId) h['X-Device-Id'] = auth.deviceId;
  return h;
}

/** 换票 / 用户信息（OAuth host）。注意：这里不带 Authorization */
function oauthHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': c.USER_AGENT,
  };
}

module.exports = { soloHeaders, ugHeaders, oauthHeaders };
