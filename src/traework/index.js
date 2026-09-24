// src/traework/index.js - TRAE Work 通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道，
// 不碰 OAuth、设备标识、SSE 聚合的细节。与 qwenwork/index.js 同构。
const c = require('./constants');
const chat = require('./chat');
const authStore = require('./auth');

/** 通道是否可用：至少有一个启用且凭证完整的账号 */
function status() {
  const usable = authStore.findUsable();
  if (!usable.length) {
    return { ready: false, loggedIn: false, error: '没有可用账号（需先登录）', accounts: 0 };
  }
  return { ready: true, loggedIn: true, error: '', accounts: usable.length };
}

/**
 * 取一个可用账号，必要时先刷新 token。
 * 单账号阶段直接取第一个；多账号轮转后续接 web-pool 的思路。
 */
async function pickAccount() {
  const list = authStore.findUsable();
  if (!list.length) throw new Error('traework 没有可用账号');
  const a = list[0];
  if (authStore.needsRefresh(a)) {
    const r = await authStore.exchange(a);
    if (!r.ok) {
      authStore.patch(a.id, { lastError: `刷新失败: ${r.error}` });
      throw new Error(`traework token 刷新失败: ${r.error}`);
    }
    authStore.patch(a.id, { ...r.patch, lastError: '' });
    return authStore.get(a.id);
  }
  return a;
}

/** 模型列表：先用静态表（上游 get_detail_param 后续再接） */
function listModels() {
  return [c.DEFAULT_MODEL];
}

/**
 * 发对话请求。
 * @param {object} payload OpenAI 格式请求体
 * @param {function} [onChunk] 流式回调（收到解出来的 OpenAI 行）
 */
async function send(payload, onChunk) {
  const auth = await pickAccount();
  const model = payload && payload.model ? String(payload.model).replace(/^traework\//, '') : c.DEFAULT_MODEL;
  const body = chat.buildBody(payload, model);

  const r = await chat.postStream(body, auth);
  if (!r.stream) {
    throw new Error(`traework 请求失败: ${r.error || ('HTTP ' + r.status)}`);
  }
  if (r.status >= 400) {
    let raw = '';
    try {
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      raw = await new Promise((res) => {
        let b = '';
        r.stream.on('data', (x) => { b += dec.write(x); });
        r.stream.on('end', () => res(b + dec.end()));
      });
    } catch (e) { /* 忽略 */ }
    const err = new Error(`traework ${r.status}: ${raw.slice(0, 200)}`);
    err.statusCode = r.status;
    throw err;
  }

  const events = [];
  await chat.readStream(r.stream, (evt) => {
    events.push(evt);
    // 流式：把 output 事件转成 OpenAI chunk 形状回调出去
    if (onChunk && evt.event === 'output') {
      onChunk(JSON.stringify(chat.toOpenAIChunk(evt, model)));
    }
  });

  if (onChunk) return { streamed: true };
  return chat.aggregate(events, model);
}

module.exports = { status, send, listModels, pickAccount, DEFAULT_MODEL: c.DEFAULT_MODEL };
