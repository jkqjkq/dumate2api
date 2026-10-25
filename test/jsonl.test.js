// test/jsonl.test.js - jsonl.js 行为测试（审计 P1-4 大小轮转）
//
// 覆盖：正常追加、超限归档 .old（保留一代）、二次轮转覆盖旧 .old、
// 目标文件不存在时的静默建档、DEFAULT_MAX_BYTES 常量。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeTmpData } = require('./helpers/tmpdata');

const jsonl = require('../src/jsonl');
const tmp = makeTmpData('jsonl');

test('DEFAULT_MAX_BYTES = 16MB', () => {
  assert.equal(jsonl.DEFAULT_MAX_BYTES, 16 * 1024 * 1024);
});

test('append：目标不存在时静默建文件并追加', () => {
  const f = tmp.file('a.jsonl');
  jsonl.append(f, '{"n":1}\n');
  jsonl.append(f, '{"n":2}\n');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"n":1}\n{"n":2}\n');
});

test('append：未超上限不轮转', () => {
  const f = tmp.file('b.jsonl');
  fs.writeFileSync(f, 'x'.repeat(100));
  jsonl.append(f, 'y', 1000);
  assert.ok(!fs.existsSync(`${f}.old`));
  assert.equal(fs.statSync(f).size, 101);
});

test('append：超上限先把当前文件归档 .old 再追加新行', () => {
  const f = tmp.file('c.jsonl');
  fs.writeFileSync(f, 'A'.repeat(64));
  jsonl.append(f, 'B\n', 32);
  assert.equal(fs.readFileSync(`${f}.old`, 'utf8'), 'A'.repeat(64), '归档保留的是轮转前内容');
  assert.equal(fs.readFileSync(f, 'utf8'), 'B\n', '新文件只含新行');
});

test('append：二次轮转覆盖旧 .old（只保留一代，gen1 丢弃）', () => {
  const f = tmp.file('d.jsonl');
  fs.writeFileSync(f, 'gen1');
  jsonl.append(f, 'g2\n', 2);
  fs.appendFileSync(f, 'more\n');
  jsonl.append(f, 'g3\n', 2); // 再触发一次轮转：此时 f 内容是 gen1 轮走后的 g2\nmore\n
  assert.equal(fs.readFileSync(`${f}.old`, 'utf8'), 'g2\nmore\n', '.old 被最新一代覆盖，gen1 已丢弃');
  assert.equal(fs.readFileSync(f, 'utf8'), 'g3\n');
});

test('rotateIfNeeded：文件不存在时静默跳过', () => {
  const f = tmp.file('missing.jsonl');
  jsonl.rotateIfNeeded(f, 10); // 不抛
  assert.ok(!fs.existsSync(f));
});

test('rotateIfNeeded：size 恰好等于上限也轮转（< 上限才跳过）', () => {
  const f = tmp.file('edge.jsonl');
  fs.writeFileSync(f, 'x'.repeat(10));
  jsonl.rotateIfNeeded(f, 10);
  assert.ok(fs.existsSync(`${f}.old`), '实现判据是 size < maxBytes 才跳过，== 触发轮转');
  assert.ok(!fs.existsSync(f), '当前文件已归档走');
});
