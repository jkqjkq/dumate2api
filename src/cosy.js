// src/cosy.js - COSY 协议签名算法（纯本地，无外部依赖）
//
// **这是 Qoder 与千问办公共用的协议栈**：同一个 client_id
// （e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb）、同一个聊天路径
// （/algo/api/v2/service/pro/sse/agent_chat_generation）、同一个
// `Bearer COSY.<payload>.<sig>` 信封、同一套 Encode=1 自定义 base64，
// 连服务端公钥都是同一个（2026-10-14 实测：用本模块给千问签名，
// gateway.qwenwork.cn 返回 200 并正常出流）。
//
// 所以算法只实现这一份，两个通道各自提供自己的常量与请求头
// （见 qoder/cosy.js 与 qwenwork/cosy-sign.js）——**不要复制第二份**：
// 下面那个 O(n²) 性能修复（见 encode 的注释）就是踩过一次的坑，
// 复制出去必然漂移。
//
// 三步流程：
//   1. cosyKey = base64( RSA_PKCS1v15( tempKey ) )        ← 服务端公钥硬编码
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
// 离线验证：node test/verify-qoder-cosy.js（与参考实现的确定性测试向量
// 逐字节比对）
const crypto = require('crypto');
const offthread = require('./offthread');

// 服务端公钥（RSA-1024，PKCS#1 v1.5）。硬编码——它不属于用户凭证，是协议常量。
// Qoder 与千问办公共用同一把（实测两个网关都接受用它签出来的请求）。
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
 * 同上的查表，但用 Uint8Array 按 ASCII 码直索引。
 *
 * 热循环里对象属性查找比数组下标慢一个量级，而这个循环对**每个字节**都跑一次
 * （一次请求几 MB），所以这里用码点直索引。0 表示「不在表内」（自定义字母表
 * 里没有 NUL，可以安全当哨兵）。
 */
const S2C_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 64; i++) t[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
  t['='.charCodeAt(0)] = CUSTOM_PAD.charCodeAt(0);
  return t;
})();

/**
 * 自定义 base64 编码：先标准 base64，再把字符串按 1/3 处重排，最后换字母表。
 * 顺序不能改——重排与换表都对结果有影响。
 *
 * **性能是这里的第一约束（2026-10-03 修，曾导致网关「假死」）**：
 * 原实现是 `let out=''; for(...) out += mapped;`。JS 字符串在 V8 里是**近似
 * O(n²)** 的（每次增长都要复制整个串），再叠上 `std.slice()` 三段重排产生的
 * 临时字符串，实测代价：
 *
 * | 输入 | 原实现 |
 * |---|---|
 * | 4 MB | 0.6 s |
 * | 16 MB | 3.1 s |
 * | 64 MB | **15.2 s** |
 * | 128 MB | **4 GB heap OOM 崩溃** |
 *
 * 因为 `encode` 是**同步**的（在 runOnce 里直接调），它一慢就**阻塞整个事件
 * 循环**：`/health` 也不响应、其他通道的请求全部排队。客户端表现为「一直转圈、
 * 没有任何输出」，而网关进程 CPU 跑满却不崩——极难自查（我这次是靠
 * `process._debugProcess` + inspector `Debugger.pause` 拿到调用栈才定位到）。
 *
 * 改法：**下标置换 + 预计算查表 + 一次性 Buffer**，全程 O(n)、无中间大字符串。
 * 重排不再真的拼接字符串——它本质是纯下标置换（新串第 i 位 = 原串第 perm(i) 位），
 * 直接算出源下标即可。
 */
function encode(plaintext) {
  const std = Buffer.from(plaintext).toString('base64');
  const n = std.length;
  if (n === 0) return '';
  const a = Math.floor(n / 3);
  // rearranged = std[n-a:] + std[a:n-a] + std[0:a]
  //   i < a            → 末段，源下标 n-a+i
  //   a <= i < n-a     → 中段，源下标 i
  //   i >= n-a         → 首段，源下标 i-(n-a)
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) {
    const src = i < a ? n - a + i : (i < n - a ? i : i - (n - a));
    const code = std.charCodeAt(src);
    const mapped = S2C_TABLE[code];
    if (mapped === 0) throw new Error(`cosy: 字符不在字母表内 (${code})`);
    out[i] = mapped;
  }
  // latin1：字节 0-255 ↔ 字符 0-255，自定义字母表全是 ASCII，无损
  return out.toString('latin1');
}

/**
 * encode 的 worker 版（审计 P1-5b）：O(n) 修复后单次代价可控，但几 MB 请求
 * 仍是几十 ms 级的独占，并发下叠加。热路径（qoder/index.js、千问本地签名）
 * 改走 encodeAsync——worker 里算，事件循环不被占；worker 起不来时回退
 * 同步版，退化成旧行为，不破坏功能。
 */
function encodeAsync(plaintext) {
  return offthread.run(__filename, 'encode', [plaintext], (p) => encode(p));
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

/** 32 位随机 UUID（v4 形状） */
function newUUID() {
  const h = crypto.randomBytes(16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 生成一次会话的两把材料。
 *
 * tempKey 是 16 字节随机数的 **hex 前 16 个字符**（即 16 个 ASCII 字节，
 * 不是 16 字节二进制）——这是参考实现的做法，必须一致。
 *
 * @param {string} identityJson 身份 JSON（**key 必须字母序**，见文件头注释）
 * @returns {{tempKey:string, cosyKey:string, info:string}}
 */
function newSession(identityJson) {
  const tempKey = crypto.randomBytes(16).toString('hex').slice(0, 16);
  const cosyKey = rsaEncrypt(tempKey).toString('base64');
  const info = aesEncrypt(Buffer.from(identityJson), Buffer.from(tempKey)).toString('base64');
  return { tempKey, cosyKey, info };
}

/**
 * 每次请求都重新构造 payload（requestId 必须新）。
 * cosyVersion 由各通道传自己的（Qoder 1.0.10 / 千问 1.1.52）——
 * 它是请求头与 payload 里都要出现的一致性字段。
 */
function buildPayloadB64(info, cosyVersion) {
  return Buffer.from(JSON.stringify({
    cosyVersion,
    ideVersion: '',
    info,
    requestId: newUUID(),
    version: 'v1',
  })).toString('base64');
}

const signRequest = (payloadB64, cosyKey, date, body, pathSig) =>
  md5hex([payloadB64, cosyKey, date, body, pathSig].join('\n'));

const composeBearer = (payloadB64, sig) => `Bearer COSY.${payloadB64}.${sig}`;

/** 身份 JSON 的字段顺序必须与 Go 的 map 序列化一致（字母序） */
function sortedJson(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return JSON.stringify(out);
}

module.exports = {
  encode, encodeAsync, aesEncrypt, rsaEncrypt, md5hex, newUUID, newSession,
  buildPayloadB64, signRequest, composeBearer, sortedJson,
  SERVER_PUBKEY_PEM, CUSTOM_ALPHABET, STD_ALPHABET, S2C,
};
