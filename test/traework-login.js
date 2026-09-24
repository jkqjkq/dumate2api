#!/usr/bin/env node
// test/traework-login.js - TRAE Work 登录 / 签到 / 验证 命令行工具
//
// 最小闭环的自测入口。三步：
//   1. node test/traework-login.js login     生成授权链接 → 粘贴回调 → 落盘
//   2. node test/traework-login.js checkin   签到 + 查额度
//   3. node test/traework-login.js chat "你好"  发一条对话验证
//
// 不依赖 TRAE 客户端：凭证由本工具自己走 OAuth 换取。
const readline = require('readline');
const authStore = require('../src/traework/auth');
const login = require('../src/traework/login');
const checkin = require('../src/traework/checkin');
const tw = require('../src/traework');
const c = require('../src/traework/constants');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function doLogin() {
  const ids = login.newDeviceIds();
  const url = login.buildAuthUrl(ids);
  console.log('\n=== 第 1 步：浏览器登录 ===');
  console.log('打开下面的地址，用 TRAE 账号登录：\n');
  console.log('  ' + url + '\n');
  console.log('登录成功后浏览器会跳到 127.0.0.1:18080（打不开是正常的），');
  console.log('把地址栏里那一整条 URL 复制下来，粘贴到下面。\n');

  const cb = await ask('粘贴回调地址：');
  if (!cb) { console.log('未输入，退出'); process.exit(1); }

  const parsed = login.parseCallback(cb);
  if (!parsed.refreshToken) {
    console.log('✗ 没解析出 refreshToken，检查粘贴的内容是否是完整回调地址');
    process.exit(1);
  }
  console.log('✓ 解析到 refreshToken（尾部 ' + parsed.refreshToken.slice(-6) + '）');
  if (parsed.uid) console.log('  uid=' + parsed.uid + ' 昵称=' + (parsed.nickname || '—'));

  const r = await login.exchangeAndSave({
    refreshToken: parsed.refreshToken,
    deviceId: ids.deviceId,
    machineId: ids.machineId,
    uid: parsed.uid,
    nickname: parsed.nickname,
  });
  if (!r.ok) { console.log('✗ 换票失败：' + r.error); process.exit(1); }
  console.log('✓ 登录成功，账号已保存：');
  console.log('  ' + JSON.stringify(r.account));
}

async function doCheckin() {
  const list = authStore.findUsable();
  if (!list.length) { console.log('✗ 没有可用账号，先跑 login'); process.exit(1); }
  for (const a of list) {
    console.log(`\n=== 账号 ${a.nickname || a.uid || a.id} ===`);
    const st = await checkin.status(a);
    console.log('  签到状态:', JSON.stringify(st));
    if (!st.ok) continue;
    const r = await checkin.checkinAndSave(a, authStore);
    console.log('  签到结果:', JSON.stringify(r));
  }
}

async function doChat(text) {
  const msg = text || '用一句话回答：中国的首都是哪里？';
  console.log('\n=== 对话测试 ===');
  console.log('  发送:', msg);
  const out = await tw.send({
    model: c.DEFAULT_MODEL,
    messages: [{ role: 'user', content: msg }],
    max_tokens: 500,
    stream: false,
  });
  const ch = out.choices && out.choices[0];
  console.log('  finish_reason:', ch && ch.finish_reason);
  console.log('  回答:', ((ch && ch.message && ch.message.content) || '(空)').slice(0, 300));
  if (ch && ch.message && ch.message.reasoning_content) {
    console.log('  思维链长度:', ch.message.reasoning_content.length, '字');
  }
  console.log('  usage:', JSON.stringify(out.usage));
}

async function main() {
  const cmd = process.argv[2] || 'help';
  try {
    if (cmd === 'login') await doLogin();
    else if (cmd === 'checkin') await doCheckin();
    else if (cmd === 'chat') await doChat(process.argv.slice(3).join(' '));
    else if (cmd === 'list') console.log(JSON.stringify(authStore.list(), null, 2));
    else {
      console.log('用法:');
      console.log('  node test/traework-login.js login          登录（生成链接→粘贴回调）');
      console.log('  node test/traework-login.js checkin        签到 + 查额度');
      console.log('  node test/traework-login.js chat "内容"    发一条对话');
      console.log('  node test/traework-login.js list           列出已保存账号');
    }
  } catch (e) {
    console.log('✗ 失败:', e.message);
    process.exit(1);
  }
}

main();
