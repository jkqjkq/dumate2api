// src/qwenwork/cosy-sign.js - 千问办公的 COSY 请求构造（纯本地签名）
//
// **不需要官方 wasm、不需要客户端**（2026-10-14 实测确认）。
// 算法本体在 src/cosy.js（与 Qoder 共用），这里只放千问特有的常量与请求头。
//
// 历史：本通道原实现必须调 qoder_auth_wasm_bg.wasm 生成请求体，理由是
// 「本地自实现的编码会被服务端拒（400 Invalid agent chat JSON body）」。
// 那是 2026-09-23 的结论——当时还没有 cosy.js（Qoder 通道 10-02 才接入，
// 它的签名算法与参考实现逐字节比对过 22 项测试向量）。
//
// 而两个产品**是同一套协议栈**：同一个 client_id、同一个聊天路径
// （/algo/api/v2/service/pro/sse/agent_chat_generation）、同一套
// `Bearer COSY.<payload>.<sig>` 信封、连服务端公钥都是同一把。
// 所以那份算法直接适用于千问——差异只有 cosyVersion（1.1.52 vs 1.0.10）
// 和几个客户端身份头。
//
// 实测（2026-10-14）：用本模块签名 → gateway.qwenwork.cn 返回 200，
// 19 帧正常出流，正文 "OK"，finish_reason=stop，usage 完整。
//
// 顺带解决两件事：
//   1. **不再依赖客户端安装目录**。wasm 是客户端资产，随卸载消失，
//      通道会直接变成 ready=false（用户 2026-10-14 卸载千问办公后即如此）。
//   2. **不再每请求 spawn 一个 Node 子进程**跑 wasm。原实现每次签名要
//      起 Node + 实例化 289KB wasm，用 execFileSync **阻塞整个事件循环**
//      几百毫秒，期间搭子链路的请求一起排队（见 index.js 的 MAX_ATTEMPTS
//      注释）。本地签名是纯 CPU 的同步计算，微秒级。
const core = require('../cosy');
const c = require('./constants');

/** 聊天路径去掉 /algo 前缀——签名用的 pathSig（与 Qoder 同一约定） */
const CHAT_PATH_SIG = c.CHAT_PATH.replace(/^\/algo/, '');

/**
 * 身份 JSON。字段与顺序对齐 wasm 的 generate_runtime_auth_fields 输入形状
 * （字母序，见 cosy.js 文件头第 1 条坑）。
 */
function identityJson({ uid, token, organizationId, organizationTags }) {
  return core.sortedJson({
    uid: uid || '',
    security_oauth_token: token || '',
    organization_id: organizationId || '',
    organization_tags: organizationTags || '',
    data_policy_agreed: true,
  });
}

/**
 * 构造一次会话。与 wasm 的 generate_runtime_auth_fields 等价：
 *   {encrypt_user_info, key} ←→ {info, cosyKey}
 */
function newSession({ uid, token, machineId }) {
  const { cosyKey, info } = core.newSession(identityJson({ uid, token }));
  return { cosyKey, info, uid, machineId };
}

/**
 * 构造全部请求头。body 是**已 Encode 的字符串**。
 * Accept 与 Content-Length 由 chat.js 的 post/postStream 统一补，这里不管。
 */
function buildHeaders(sess, pathSig, body, accept, extra) {
  const payloadB64 = core.buildPayloadB64(sess.info, c.COSY_VERSION);
  const date = String(Math.floor(Date.now() / 1000));
  const headers = {
    'cosy-data-policy': 'agree',
    'content-type': 'application/json',
    'cosy-clienttype': c.CLIENT_TYPE,
    'cosy-date': date,
    'cosy-user': sess.uid || '',
    'cosy-key': sess.cosyKey,
    'cache-control': 'no-cache',
    accept,
    authorization: core.composeBearer(
      payloadB64,
      core.signRequest(payloadB64, sess.cosyKey, date, body, pathSig),
    ),
    'cosy-version': c.COSY_VERSION,
    'cosy-machineid': sess.machineId || '',
    'login-version': c.LOGIN_VERSION,
    'user-agent': c.USER_AGENT,
    'cosy-scene': c.SCENE,
    'cosy-business-product': c.BUSINESS_PRODUCT,
    'cosy-business-type': c.BUSINESS_TYPE,
  };
  return Object.assign(headers, extra || {});
}

/**
 * 生成一次推理请求。接口与 bridge.prepareInfer **完全一致**
 * （输入 {uid, token, bodyJson, modelKey, machineId}，输出 {url, body, headers}），
 * 所以上层调用点不需要任何改动。
 *
 * 模型 key 要同时进 body 与请求头——只设 body 时上游仍按 auto 走
 * （与 Qoder 同一个坑，见 constants 的 modelConfig 注释）。
 */
function prepareInfer({ uid, token, bodyJson, modelKey, machineId }) {
  const sess = newSession({ uid, token, machineId });
  const body = core.encode(bodyJson);
  const headers = buildHeaders(sess, CHAT_PATH_SIG, body, 'text/event-stream', {
    'x-model-key': modelKey,
    'x-model-source': 'system',
  });
  return { url: c.GATEWAY + c.CHAT_PATH + '?' + c.CHAT_QUERY, body, headers };
}

module.exports = { prepareInfer, newSession, buildHeaders, identityJson, CHAT_PATH_SIG };
