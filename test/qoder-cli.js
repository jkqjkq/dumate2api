// test/qoder-cli.js - Qoder 通道命令行自测（不开管理端也能验证）
//
// 用法:
//   node test/qoder-cli.js login [cn|global]   # 生成授权链接（粘回调后自动轮询取票）
//   node test/qoder-cli.js status              # 通道状态 + 账号列表
//   node test/qoder-cli.js models              # 模型表（带倍率）
//   node test/qoder-cli.js quota               # 额度
//   node test/qoder-cli.js checkin             # 签到领积分
//   node test/qoder-cli.js chat "你好" [model]  # 发一条对话（默认用最省的 0.1 档模型）
//   node test/qoder-cli.js remove <id>         # 删账号
//
// 与 test/traework-login.js 同定位：排查「Qoder 到底通不通」时比开管理端更快。
const path = require('path');
const qoder = require('../src/qoder');
const authStore = require('../src/qoder/auth');
const login = require('../src/qoder/login');
const session = require('../src/qoder/session');
const constants = require('../src/qoder/constants');

const cmd = process.argv[2] || 'status';

/** 轮询直到取票成功（或超时），用于 login 命令 */
async function waitLogin(nonce, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write('等待授权');
  while (Date.now() < deadline) {
    const r = await login.pollFlow(nonce);
    if (r.status === 'ok') { console.log('\n✓ 登录成功'); return r; }
    if (r.status === 'error') { console.log('\n✗ ' + r.error); return r; }
    process.stdout.write('.');
    await new Promise((s) => setTimeout(s, 2000));
  }
  console.log('\n超时');
  return { status: 'error', error: 'timeout' };
}

(async () => {
  if (cmd === 'login') {
    const region = process.argv[3] || 'cn';
    const f = login.startFlow(region);
    console.log(`\nQoder 登录（区域 ${f.region}）\n`);
    console.log('在浏览器打开这个地址并登录:\n');
    console.log('  ' + f.url + '\n');
    const r = await waitLogin(f.nonce);
    if (r.status === 'ok') {
      const a = r.account;
      console.log(`  账号: ${a.nickname} (id=${a.id}, uid=${a.uid.slice(0, 8)}…)`);
      console.log(`  区域: ${a.region} | 套餐: ${a.planName || '-'}`);
      console.log('\n下一步: node test/qoder-cli.js checkin   （新账号额度为 0，必须先签到领积分）');
    }
    return;
  }

  if (cmd === 'status') {
    const st = qoder.status();
    console.log('通道状态:', JSON.stringify(st, null, 2));
    console.log('\n账号列表:');
    for (const a of authStore.list()) {
      console.log(`  [${a.id}] ${a.nickname || '(无名)'} | ${a.region} | ${a.planName || '-'} | ` +
        `token ${a.hasAccess ? '有' : '无'} | ${a.enabled ? '启用' : '停用'}${a.preferred ? ' | 主账号' : ''}` +
        (a.lastError ? ` | 错误: ${a.lastError}` : ''));
    }
    return;
  }

  if (cmd === 'models') {
    const account = qoder.pickAccount();
    const region = constants.normalizeRegion(account.region);
    const ep = constants.endpointsOf(region);
    // 直接打上游拿完整表（含倍率），不用 listModels 的裸 id
    const cosy = require('../src/qoder/cosy');
    const https = require('https');
    const auth = await session.ensureAccount(authStore, account);
    const sess = cosy.newSession({
      name: auth.nickname || '', aid: auth.uid || '', uid: auth.uid || '',
      userType: auth.userType || 'personal_standard',
      securityOauthToken: auth.accessToken, refreshToken: auth.refreshToken,
    }, auth.machineId || '', auth.machineToken || '', auth.machineType || '5');
    const headers = cosy.buildHeaders(sess, ep.ModelsPathSig, '', 'application/json', { 'accept-encoding': 'identity' });
    const u = new URL(ep.ModelListURL);
    const raw = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, timeout: 20000 }, (r) => {
        let b = ''; r.on('data', (x) => { b += x; }); r.on('end', () => resolve(b));
      });
      req.on('error', reject); req.end();
    });
    const list = (JSON.parse(raw).chat || []).filter((m) => m.enable !== false);
    list.sort((a, b) => (a.price_factor || 99) - (b.price_factor || 99));
    console.log(`模型表（${list.length} 个，按倍率升序）:\n`);
    for (const m of list) {
      const cheap = m.price_factor <= 0.1 ? ' ← 调试用' : '';
      console.log(`  ${String(m.price_factor).padEnd(5)} | ${String(m.key).padEnd(16)} | ${String(m.display_name || '').padEnd(22)} | ctx=${m.max_input_tokens || '-'}${cheap}`);
    }
    return;
  }

  if (cmd === 'quota') {
    const q = await qoder.quota();
    console.log('额度:', JSON.stringify(q, null, 2));
    return;
  }

  if (cmd === 'checkin') {
    const account = qoder.pickAccount();
    console.log(`对账号 ${account.nickname || account.id} 签到…`);
    const r = await qoder.checkin(account);
    console.log(JSON.stringify(r, null, 2));
    if (r.ok && r.gained != null) {
      console.log(`\n实际到账: ${r.gained} credits（${r.before ? r.before.remaining : '?'} → ${r.after ? r.after.remaining : '?'}）`);
    }
    return;
  }

  if (cmd === 'chat') {
    const text = process.argv[3] || '你好';
    // 默认用最省的模型——调试别烧额度（0.1 倍率，见 constants.CHEAP_MODELS）
    const model = process.argv[4] || 'gfmodel';
    console.log(`发送: "${text}"（model=${model}）\n`);
    const t0 = Date.now();
    const r = await qoder.chatCompletion({ model, messages: [{ role: 'user', content: text }], max_tokens: 256 });
    const msg = r.choices && r.choices[0] && r.choices[0].message;
    console.log(`HTTP OK (${Date.now() - t0}ms) | usage=${JSON.stringify(r.usage)}`);
    if (msg && msg.reasoning_content) console.log(`\n[推理] ${msg.reasoning_content.slice(0, 200)}`);
    console.log(`\n[正文]\n${msg ? msg.content : '(空)'}`);
    return;
  }

  if (cmd === 'remove') {
    const id = process.argv[3];
    if (!id) { console.log('用法: remove <id>'); return; }
    console.log(authStore.remove(id) ? `已删除账号 ${id}` : `未找到账号 ${id}`);
    return;
  }

  console.log('未知命令。可用: login | status | models | quota | checkin | chat | remove');
})();
