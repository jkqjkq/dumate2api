// test/verify-display-name.js - 「账号显示名」解析的离线验证
//
// 不依赖网关/上游：直接验证 src/accounts.js 的 displayName 纯函数。
//
// 背景（2026-09-29）：用户报「搭子仪表盘为何还显示账号 1 而不是真实用户名」。
// 根因是 create() 在用户没填名字时会写入占位名「账号 N」，而 nickname 只在
// **浏览器登录**那条路径（/login/poll）回填——手动粘贴 cookie 添加的账号
// 走 POST /web-accounts，那条路径从不写 nickname。于是这些账号的显示名
// 永久停在占位名上，即使上游明明返回了「张三」。
//
// 修法有两半，这个脚本验证第二半（第一半是 backfillNickname，要打上游，
// 不在离线验证范围内）：
//   1. 触达上游的路径顺手补 nickname（幂等，已有则不打上游）
//   2. 显示名统一走 displayName()：**用户填的名字 > 上游昵称 > 占位名**
const { displayName } = require('../src/accounts');

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

console.log('== displayName：占位名必须被真实昵称顶掉 ==');

// 这就是用户报的那个 case
check('占位名 + 有昵称 → 用昵称', displayName({ id: 1, name: '账号 1', nickname: '张三' }), '张三');

// 用户填了名字就尊重用户，即使上游有昵称
check('用户填的名字优先于昵称', displayName({ id: 1, name: '我的号', nickname: '张三' }), '我的号');

// 用户真想起名叫「账号 1」时不该被覆盖——所以占位名只认「账号 + 数字」整串
check('「账号 1 号机」不算占位名', displayName({ id: 1, name: '账号 1 号机', nickname: '张三' }), '账号 1 号机');
check('「账号一号」不算占位名', displayName({ id: 1, name: '账号一号', nickname: '张三' }), '账号一号');

// 占位名的各种合法写法（含多余空格）
check('「账号1」无空格也算占位名', displayName({ id: 3, name: '账号1', nickname: 'nick' }), 'nick');
check('「账号  7」多空格也算占位名', displayName({ id: 7, name: '账号  7', nickname: 'nick' }), 'nick');

// 两边都没有 → 兜底到占位名，不能返回空串（界面会显示空白）
check('占位名 + 无昵称 → 保留占位名', displayName({ id: 5, name: '账号 5', nickname: '' }), '账号 5');
check('name 为空 + 有昵称 → 用昵称', displayName({ id: 5, name: '', nickname: 'nick' }), 'nick');
check('name 为空 + 无昵称 → 兜底占位名', displayName({ id: 9, name: '', nickname: '' }), '账号 9');

// 昵称是纯空白等同于没有
check('昵称只有空格 → 视为无', displayName({ id: 5, name: '账号 5', nickname: '   ' }), '账号 5');

// 空账号对象不该抛异常（接口在账号被删的边界上会走到这里）
check('null → 空串', displayName(null), '');
check('undefined → 空串', displayName(undefined), '');

console.log('');
console.log('== toPublic：所有访问器必须给出同一个名字 ==');

// 这是「改了 9 个模块漏了 3 个调用点」那个 bug 的根因：
// list() 解析了显示名而 get() 没有，同一个账号两个名字。
// 现在收敛到 toPublic，这个契约必须成立。
const { toPublic } = require('../src/accounts');
const rec = { id: 1, name: '账号 1', nickname: '张三', cookie: 'BDUSS=secret' };
const pub = toPublic(rec);
check('toPublic 覆盖 name 为显示名', pub.name, '张三');
check('toPublic 保留原始标签到 label', pub.label, '账号 1');
check('toPublic 抹掉 cookie', pub.cookie, undefined);
check('toPublic 保留 cookie_len', pub.cookie_len, 'BDUSS=secret'.length);
check('toPublic(null) → null', toPublic(null), null);

console.log('');
if (failures) {
  console.log(`✗ ${failures} 项失败`);
  process.exit(1);
}
console.log('✓ 全部通过');
