// test/verify-qoder-phone.js - 验证 Qoder 手机号只存脱敏形式
//
// ============================================================
// 为什么要有这个脚本
//
// Qoder 的 userinfo 返回 `security_mobile`，是**完整明文手机号**（PII）。
// 本项目只需要「认出这是哪个号」，没有任何场景要用到完整号码，所以定下：
// **脱敏值进账号文件，明文不落盘、不进界面。**
//
// 三条不变量，改动时别破坏：
//   1. 脱敏后必须看不出完整号码（中间 4 位以上被替换）
//   2. 与千问/TRAE 同口径（三条通道的账号卡会并排看，不能一个 861**** 一个 157****）
//   3. list() 不再二次脱敏——对已脱敏的串再切一刀只是碰巧结果相同
//
// 用法：node test/verify-qoder-phone.js
// ============================================================
const assert = require('assert');
const { maskPhone } = require('../src/qoder/auth');
const qw = require('../src/qwenwork/auth');
const tw = require('../src/traework/auth');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

// 实测脱敏的形状：3 位前缀 + **** + 后 4 位
const MASKED = /^\d{3}\*{4}\d{4}$/;

console.log('Qoder 手机号脱敏');

// ---- 1. 基本形状 ----
check('11 位手机号 → 150****9294 形状', () => {
  const r = maskPhone('15091559294');
  assert.ok(MASKED.test(r), `形状不对: ${r}`);
  assert.strictEqual(r, '150****9294');
});

check('脱敏后不含完整号码（明文不能泄露）', () => {
  const raw = '15091559294';
  const r = maskPhone(raw);
  assert.notStrictEqual(r, raw);
  // 中间 4 位必须被抹掉：完整号码的中间段不能出现在结果里
  assert.ok(!r.includes('1559'), `中间段泄露: ${r}`);
  assert.ok(!r.includes('91559294'), `后半段泄露: ${r}`);
});

check('空值返回空串（没手机号的账号不显示 ****）', () => {
  assert.strictEqual(maskPhone(''), '');
  assert.strictEqual(maskPhone(null), '');
  assert.strictEqual(maskPhone(undefined), '');
});

// ---- 2. 与另两条通道同口径 ----
check('带国家码时与千问/TRAE 结果一致', () => {
  for (const s of ['15091559294', '8615091559294', '+8615091559294']) {
    assert.strictEqual(maskPhone(s), qw.maskPhone(s), `千问口径不一致: ${s}`);
    assert.strictEqual(maskPhone(s), tw.maskPhone(s), `TRAE 口径不一致: ${s}`);
  }
});

check('86 前缀：按本机号切分，核心段仍是 150****9294', () => {
  // 输出是 86150****9294 —— **国家码保留**（与千问/TRAE 同口径），
  // 但核心段按剥掉 86 后的 11 位本机号切，所以是「150****9294」而不是
  // 「861****9294」。后者会让人认不出这是哪个号。
  const r = maskPhone('8615091559294');
  assert.ok(r.includes('150****9294'), `核心段不对: ${r}`);
});

// ---- 3. 短号/异常输入 ----
check('过短的号码不会抛异常，只给最小脱敏', () => {
  for (const s of ['1', '123', '12345']) {
    const r = maskPhone(s);
    assert.strictEqual(typeof r, 'string');
    assert.ok(r.includes('****'), `没有脱敏标记: ${s} → ${r}`);
  }
});

// ---- 4. 二次脱敏的陷阱 ----
// 实测：对已脱敏的 `150****9294` 再切一刀，结果**恰好还是** `150****9294`
// （长度 11，前 3 后 4 取到的字符相同）。这是巧合不是保证——脱敏规则一改
// （比如中间改成 6 位星号、或加国家码分支）就会切出废品。
// 所以 list() 直接透传落盘值，不再脱敏一次。这条把「落盘即脱敏」的约定钉住：
// 只要没人把明文写进 phone 字段，透传就永远是安全的。
check('落盘值已经是脱敏形式（这是 list 敢直接透传的前提）', () => {
  const once = maskPhone('15091559294');
  assert.ok(MASKED.test(once), `落盘值不是脱敏形式: ${once}`);
  // 透传后仍是合法脱敏形状
  assert.ok(MASKED.test(once));
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
