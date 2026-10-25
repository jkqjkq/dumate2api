// test/fileperm.test.js - fileperm.js 行为测试（审计 P1-3 权限收紧）
//
// fileperm 是「尽力而为」语义：POSIX 上 chmod 0600，Windows 上用 icacls
// 收紧目录 ACL。本机是 Windows，POSIX 分支无法在本测试覆盖（标注未执行）；
// Windows 侧测 harden 的可观测行为：不抛错（含目标不存在、目录重复收紧
// 的去重路径），且收紧后的临时目录里新建文件仍可正常读写（icacls 授予
// 当前用户 (OI)(CI)F 后不应把自己锁在门外）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmpData } = require('./helpers/tmpdata');

const fileperm = require('../src/fileperm');
const tmp = makeTmpData('fileperm');

test('harden：真实存在的文件不抛（Windows 走目录 icacls 路径）', () => {
  const f = tmp.file('cred.json');
  fs.writeFileSync(f, '{"token":"x"}');
  fileperm.harden(f); // 不抛即通过
  assert.equal(fs.readFileSync(f, 'utf8'), '{"token":"x"}');
});

test('harden：收紧后的目录仍允许当前用户新建并读写文件', () => {
  // hardenDirWindows 会 grant 当前用户 (OI)(CI)F 并断开继承；
  // 断言加固动作没有把测试进程自己关在门外
  const f = tmp.file('after.json');
  fileperm.harden(tmp.file('seed.json'));
  fs.writeFileSync(f, 'ok');
  assert.equal(fs.readFileSync(f, 'utf8'), 'ok');
});

test('harden：目标文件不存在也不抛', () => {
  fileperm.harden(path.join(tmp.dir, 'ghost', 'nope.json'));
});

test('harden：同一目录重复调用不抛（每进程去重路径）', () => {
  const f = tmp.file('dedupe.json');
  fs.writeFileSync(f, 'x');
  fileperm.harden(f);
  fileperm.harden(f); // 第二次走 hardenedDirs 去重
  fileperm.harden(path.join(tmp.dir, 'another.json'));
});
