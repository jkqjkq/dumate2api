// src/qoder/cosy.js - Qoder COSY 协议签名（纯本地算法）
//
// 这是本通道与千问办公最大的不同：**不需要官方 wasm**。
// 千问的请求体必须由 qoder_auth_wasm_bg.wasm 生成，本地自实现会被服务端拒；
// Qoder 的签名是一套可复现的密码学流程，纯 Node 内置 crypto 即可完成。
//
// 三步：
//   1. cosyKey = base64( RSA_PKCS1v15( tempKey ) )       ← 服务端公钥硬编码
//   2. info    = base64( AES-128-CBC( 身份JSON, tempKey ) ) ← IV = tempKey[:16]，PKCS#7
//   3. 每次请求：payloadB64 = base64({cosyVersion,ideVersion,info,requestId,version})
//                sig = md5( payloadB64 + "\n" + cosyKey + "\n" + date + "\n" + body + "\n" + pathSig )
//                Authorization: Bearer COSY.<payloadB64>.<sig>
//
// 两个实测踩过的坑（都会导致上游报 "Signature invalid"，但极难自查）：
//   1. **JSON key 必须字母序**。Go 的 json.Marshal(map) 会排序 key，JS 的
//      JSON.stringify 用插入顺序——顺序不同则 AES 密文不同，签名随之不同。
//   2. **AES 必须关掉 Node 的自动补位**（setAutoPadding(false)）。本算法
//      自己做了 PKCS#7，Node 默认还会再补一次，密文多出一个 block。
//
// 离线验证：node test/verify-qoder-cosy.js（与参考实现的确定性测试向量逐字节比对）
const crypto = require('crypto');
const c = require('./constants');

// 服务端公钥（RSA-1024，PKCS#1 v1.5）。硬编码——它不属于用户凭证，是协议常量。
const SERVER_PUBKEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc',
  '4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l',
  '6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17',
  'XcW+ML9FoCI6AOvOzwIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');

// 自定义 base64 字母表（Encode=1 用的变体）
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CUSTOM_PAD = '$';

/** std 字符 → custom 字符 */
const S2C = (() => {
  const m = {};
  for (let i = 0; i < 64; i++) m[STD_ALPHABET[i]] = CUSTOM_ALPHABET[i];
  m['='] = CUSTOM_PAD;
  return m;
})();

/**
 * 自定义 base64 编码：先标准 base64，再把字符串按 1/3 处重排，最后换字母表。
 * 顺序不能改——重排与换表都对结果有影响。
 */
function encode(plaintext) {
  const std = Buffer.from(plaintext).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  // 重排：末段 + 中段 + 首段
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (let i = 0; i < n; i++) {
    const mapped = S2C[rearranged[i]];
    if (mapped === undefined) throw new Error(`qoder cosy: 字符不在字母表内 (${rearranged.charCodeAt(i)})`);
    out += mapped;
  }
  return out;
}

/**
 * AES-128-CBC + PKCS#7，IV 取 key 前 16 字节。
 * **必须 setAutoPadding(false)**：本函数已手工补位，Node 默认会再补一次。
 */
function aesEncrypt(plain, key) {
  const block = Buffer.from(key);
  const bs = 16;
  const pad = bs - (plain.length % bs);
  const padded = Buffer.concat([Buffer.from(plain), Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', block, block.slice(0, bs));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

/** RSA PKCS#1 v1.5 加密（与 Go 的 EncryptPKCS1v15 等价） */
function rsaEncrypt(plaintext) {
  return crypto.publicEncrypt(
    { key: SERVER_PUBKEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext),
  );
}

const md5hex = (s) => crypto.createHash('md5').update(s).digest('hex');

/** 身份 JSON 的字段顺序必须与 Go 的 map 序列化一致（字母序） */
function identityJson(id) {
  const raw = {
    aid: id.aid || '',
    name: id.name || '',
    organization_id: id.organizationId || '',
    organization_name: id.organizationName || '',
    refresh_token: id.refreshToken || '',
    security_oauth_token: id.securityOauthToken || '',
    uid: id.uid || '',
    user_type: id.userType || '',
    yx_uid: id.yxUid || '',
  };
  const sorted = {};
  for (const k of Object.keys(raw).sort()) sorted[k] = raw[k];
  return JSON.stringify(sorted);
}

/** 32 位随机 UUID（v4 形状） */
function newUUID() {
  const h = crypto.randomBytes(16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 构造一个会话（一次登录对应一个）。
 *
 * tempKey 是 16 字节随机数的 **hex 前 16 个字符**（即 16 个 ASCII 字节，
 * 不是 16 字节二进制）——这是参考实现的做法，必须一致。
 */
function newSession(id, machineId, machineToken, machineType) {
  const tempKey = crypto.randomBytes(16).toString('hex').slice(0, 16);
  const cosyKey = rsaEncrypt(tempKey).toString('base64');
  const info = aesEncrypt(Buffer.from(identityJson(id)), Buffer.from(tempKey)).toString('base64');
  return { cosyKey, info, identity: id, machineId, machineToken, machineType };
}

/** 每次请求都重新构造 payload（requestId 必须新） */
function buildPayloadB64(info) {
  return Buffer.from(JSON.stringify({
    cosyVersion: c.COSY_VERSION,
    ideVersion: '',
    info,
    requestId: newUUID(),
    version: 'v1',
  })).toString('base64');
}

const signRequest = (payloadB64, cosyKey, date, body, pathSig) =>
  md5hex([payloadB64, cosyKey, date, body, pathSig].join('\n'));

/**
 * 旧式签名：md5("cosy&<secret>&<date>")。只有 PAT → jobToken 那条路用得到
 * （见 auth.js 的 exchangeJobToken），device flow 不用。
 *
 * **注意 secret 是 base64 字符串本身**（`d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==`），
 * 不是它解码出来的 "war, war never changes"——参考实现就是直接拼这个字面量。
 * 我第一版按「解码后使用」写，签名对不上。
 */
const SIGN_LEGACY_SECRET = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==';
const signLegacy = (date) => md5hex([c.APP_CODE, SIGN_LEGACY_SECRET, date].join('&'));

const composeBearer = (payloadB64, sig) => `Bearer COSY.${payloadB64}.${sig}`;

/**
 * 构造一次请求的全部头。body 是**已 Encode 的字符串**（空 body 传 ''）。
 * pathSig 是去掉 /algo 前缀的 path（见 constants 的 ChatPathSig）。
 */
function buildHeaders(sess, pathSig, body, accept, extra) {
  const payloadB64 = buildPayloadB64(sess.info);
  const date = String(Math.floor(Date.now() / 1000));
  const headers = {
    'cosy-data-policy': 'agree',
    'content-type': 'application/json',
    'cosy-machinetype': sess.machineType,
    'cosy-clienttype': c.CLIENT_TYPE,
    'cosy-date': date,
    'cosy-user': sess.identity.uid || '',
    'cosy-key': sess.cosyKey,
    'cache-control': 'no-cache',
    accept,
    authorization: composeBearer(payloadB64, signRequest(payloadB64, sess.cosyKey, date, body, pathSig)),
    'cosy-version': c.COSY_VERSION,
    'cosy-machineid': sess.machineId,
    'cosy-machinetoken': sess.machineToken,
    'login-version': c.LOGIN_VERSION,
    'user-agent': 'Go-http-client/2.0',
    'cosy-scene': 'assistant',
    'cosy-business-product': 'cli',
    'cosy-business-type': 'agent',
  };
  return Object.assign(headers, extra || {});
}

module.exports = {
  encode, aesEncrypt, rsaEncrypt, md5hex, identityJson,
  newUUID, newSession, buildPayloadB64, signRequest, signLegacy, composeBearer, buildHeaders,
  SERVER_PUBKEY_PEM, CUSTOM_ALPHABET, SIGN_LEGACY_SECRET,
};
