// test/cosy.test.js - cosy.js 行为测试（COSY 协议签名算法）
//
// encode 的正确性用「置换公式独立复算」验证：按文件头注释的重排规则
// （新串第 i 位 = 原串第 perm(i) 位）用导出的 S2C 映射独立算一遍，与
// encode 输出逐字符比对——公式与实现互为印证。AES 用解密回环验证手工
// PKCS#7（setAutoPadding(false) 的坑）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const cosy = require('../src/cosy');

// 独立复算：标准 base64 → 三段重排 → 换字母表
function expectedEncode(plaintext) {
  const std = Buffer.from(plaintext).toString('base64');
  const n = std.length;
  if (!n) return '';
  const a = Math.floor(n / 3);
  let out = '';
  for (let i = 0; i < n; i++) {
    const src = i < a ? n - a + i : (i < n - a ? i : i - (n - a));
    out += cosy.S2C[std[src]];
  }
  return out;
}

test('encode：置换公式独立复算一致（短串 / 整块 / 非对齐长度）', () => {
  for (const plain of ['a', 'ab', 'abc', 'abcd', 'hello world!', '你好，COSY 签名测试。']) {
    assert.equal(cosy.encode(plain), expectedEncode(plain), `plaintext: ${plain}`);
  }
});

test('encode：空输入返回空串；输出字符全部落在自定义字母表 + 填充符', () => {
  assert.equal(cosy.encode(''), '');
  const legal = new Set([...cosy.CUSTOM_ALPHABET, '$']);
  for (const plain of ['payload-body', 'x'.repeat(999)]) {
    for (const ch of cosy.encode(plain)) assert.ok(legal.has(ch), `非法字符: ${ch}`);
  }
});

test('encode：大输入 O(n) 且结果稳定（同输入两次编码一致）', () => {
  const big = crypto.randomBytes(512 * 1024).toString('hex').slice(0, 1024 * 1024);
  const a = cosy.encode(big);
  const b = cosy.encode(big);
  assert.equal(a, b);
  assert.equal(a.length, Buffer.from(big).toString('base64').length);
});

test('aesEncrypt：手工 PKCS#7 回环解密还原原文', () => {
  const key = '0123456789abcdef';
  for (const plain of ['hello world', 'x'.repeat(16), '长度不是块整数倍的字节串!']) {
    const enc = cosy.aesEncrypt(Buffer.from(plain), Buffer.from(key));
    const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(key).slice(0, 16));
    d.setAutoPadding(false);
    const dec = Buffer.concat([d.update(enc), d.final()]);
    const pad = dec[dec.length - 1];
    assert.equal(dec.slice(0, dec.length - pad).toString(), plain);
  }
});

test('aesEncrypt：密文长度总是 16 字节块的整数倍（Node 自动补位已关）', () => {
  const key = '0123456789abcdef';
  assert.equal(cosy.aesEncrypt(Buffer.from('abc'), Buffer.from(key)).length, 16);
  assert.equal(cosy.aesEncrypt(Buffer.from('a'.repeat(16)), Buffer.from(key)).length, 32,
    '整块长度也要补一整块 pad');
});

test('sortedJson：key 字母序输出（Go map 序列化对齐）', () => {
  assert.equal(cosy.sortedJson({ b: 1, a: 2, c: 3 }), '{"a":2,"b":1,"c":3}');
  assert.equal(cosy.sortedJson({}), '{}');
  assert.equal(cosy.sortedJson({ z: 1, A: 2 }), '{"A":2,"z":1}', '大写排在小写前（ASCII 序）');
});

test('md5hex：已知测试向量', () => {
  assert.equal(cosy.md5hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(cosy.md5hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
});

test('signRequest：五段 \n 连接后 md5，确定性', () => {
  const sig1 = cosy.signRequest('p', 'k', '2026-10-25', 'body', 'pathsig');
  const sig2 = cosy.signRequest('p', 'k', '2026-10-25', 'body', 'pathsig');
  assert.equal(sig1, sig2);
  assert.equal(sig1, cosy.md5hex(['p', 'k', '2026-10-25', 'body', 'pathsig'].join('\n')));
  assert.notEqual(cosy.signRequest('p', 'k', '2026-10-25', 'body2', 'pathsig'), sig1, '任一段变化签名即变');
});

test('composeBearer：Bearer COSY.<payload>.<sig> 形状', () => {
  assert.equal(cosy.composeBearer('PAY', 'SIG'), 'Bearer COSY.PAY.SIG');
});

test('newUUID：v4 形状 36 字符', () => {
  for (let i = 0; i < 20; i++) {
    assert.match(cosy.newUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
  assert.notEqual(cosy.newUUID(), cosy.newUUID());
});

test('newSession：tempKey 16 字符 hex、cosyKey 是 RSA-1024 密文、info 块对齐', () => {
  const s = cosy.newSession('{"deviceId":"x","os":"win"}');
  assert.match(s.tempKey, /^[0-9a-f]{16}$/);
  assert.equal(Buffer.from(s.cosyKey, 'base64').length, 128, 'RSA-1024 密文 128 字节');
  assert.equal(Buffer.from(s.info, 'base64').length % 16, 0, 'AES-CBC 块对齐');
  const s2 = cosy.newSession('{"deviceId":"x","os":"win"}');
  assert.notEqual(s.tempKey, s2.tempKey, '每次会话材料独立');
});

test('encodeAsync：worker 版与同步版结果一致（走 offthread 通道）', async () => {
  const plain = 'async-encode-一致性校验';
  assert.equal(await cosy.encodeAsync(plain), cosy.encode(plain));
});
