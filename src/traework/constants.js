// src/traework/constants.js - TRAE Work (SOLO CN) 端点与常量
//
// 逆向自 trae-api-proxy / traework2api 两个开源实现，并交叉验证：
// 两处对 ClientID、Function、端点路径的取值一致，可信度较高。
//
// 与搭子/千问不同，TRAE 的接口分成三个 host，各自有独立的请求头：
//   AgentHost  对话 + 模型列表（SOLO 专有头，14 个）
//   UgHost     签到 + 额度（只需 X-User-Region + X-Device-Id）
//   OAuthHost  换票 + 用户信息（几乎裸请求，仅 UA）
// 混用会失败，所以这里按用途分开定义。
const https = require('https');

// ---- 主机 ----
const AGENT_HOST = 'https://trae-api-cn.mchost.guru';
const UG_HOST = 'https://api.trae.cn';
const OAUTH_HOST = 'https://api.trae.com.cn';
const CONSOLE_HOST = 'https://www.trae.cn';

// ---- 端点 ----
const EP_CHAT = '/api/agent/v3/llm_utils_chat';
const EP_MODELS = '/api/ide/v1/get_detail_param';
const EP_EXCHANGE = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const EP_USER_INFO = '/cloudide/api/v3/trae/GetUserInfo';
const EP_CHECKIN_STATUS = '/trae/api/v2/ug/checkin_credits/status';
const EP_CHECKIN_CLAIM = '/trae/api/v2/ug/checkin_credits/claim';
const EP_ENT_USAGE = '/trae/api/v2/pay/ide_user_ent_usage';

// ---- 客户端标识 ----
// 这些值随客户端版本变化。升级 TRAE 后若接口报错，优先核对这几个。
const CLIENT_ID = 'en1oxy7wnw8j9n';           // SOLO stable
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const IDE_VERSION = '0.1.43';
const IDE_VERSION_CODE = '20260716';
const DEVICE_BRAND = '83DG';
const OS_VERSION = 'Windows 11 Pro';
// 对话必须带这个 function，否则上游不认（等同千问的 business 字段）
const FUNCTION = 'solo_work_lite';
// 默认模型：实测可用
const DEFAULT_MODEL = 'glm-5.2';

const USER_AGENT = `Trae/${IDE_VERSION}`;

// ---- 客户端身份（签到/额度接口的设备指纹校验用）----
// 客户端是 VSCode 内核，UA 与 market-client-id 都要跟着装成 VSCode——
// 写 Trae/0.1.43 会被服务端识别为非客户端，签到被拒（实测 9074）。
// 取值对齐 TraeWorkAssistant 的 build_headers。
const UA_VSCODE = 'VSCode 1.107.1 (TRAE SOLO CN)';
const MARKET_CLIENT_ID = 'VSCode 1.107.1';
const APP_VERSION = '0.1.45';

// 超时：对话是长流，必须用无总超时的客户端，否则 SSE 会被截断
const TIMEOUT_MS = 30000;
const STREAM_TIMEOUT_MS = 600000;

/** 统一发 JSON 请求。返回 { status, data, raw, error } */
function request(host, path, { method = 'POST', body = null, headers = {}, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const u = new URL(host + path);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout,
    }, (res) => {
      let buf = '';
      // StringDecoder：跨 chunk 的汉字不能逐块解码（会变 U+FFFD）
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (c) => { buf += dec.write(c); });
      res.on('end', () => {
        buf += dec.end();
        let data = null;
        try { data = JSON.parse(buf); } catch (e) { /* 非 JSON 保留 raw */ }
        resolve({ status: res.statusCode, data, raw: buf, error: null });
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, raw: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, raw: '', error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = {
  AGENT_HOST, UG_HOST, OAUTH_HOST, CONSOLE_HOST,
  EP_CHAT, EP_MODELS, EP_EXCHANGE, EP_USER_INFO,
  EP_CHECKIN_STATUS, EP_CHECKIN_CLAIM, EP_ENT_USAGE,
  CLIENT_ID, APP_ID, IDE_VERSION, IDE_VERSION_CODE,
  DEVICE_BRAND, OS_VERSION, FUNCTION, DEFAULT_MODEL,
  USER_AGENT, UA_VSCODE, MARKET_CLIENT_ID, APP_VERSION, TIMEOUT_MS, STREAM_TIMEOUT_MS,
  request,
};
