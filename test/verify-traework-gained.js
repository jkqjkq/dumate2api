// test/verify-traework-gained.js - 「签到实际到账」计算的离线验证
//
// 不依赖网关/上游：直接验证 src/traework/checkin.js 的 computeGained 纯函数。
//
// 背景（2026-09-29）：用户报「签到成功显示的积分还是旧的」。实测排查确认
// 数据链路是新鲜的（上游 usage_summary、额度包、落盘 credits 三者一致，
// 签到奖励确实已计入 limit），问题出在**签到结果只报总额、不报到账增量**：
//   1. 上游 claim 只回 {code:0, message:"success"}，从不告诉发了多少；
//   2. status 的 credits 是「签到可得」的固定值（150），不等于实际入账；
//   3. 上游 status 与 usage 不同步时（status 说没签、usage 已含奖励），
//      网关会走「签到成功」分支，余额却纹丝不动——用户读成「显示旧值」。
//
// 修法：签到前后各取一次余额，用差值算实际到账，并把「前 → 后」一并报出。
const { computeGained } = require('../src/traework/checkin');

let failures = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('== computeGained ==');

// 正常：签到发了 150
check('4000 → 4150 得 150', computeGained(4000, 4150, null) === 150);
check('带小数也保留 4 位', computeGained(3845.16, 3845.16 + 150.1234, null) === 150.1234);

// 奖励延迟入账：前后相同，如实给 0 而不是 null
check('4150 → 4150 得 0（不粉饰成 null）', computeGained(4150, 4150, null) === 0);

// 余额反降（上游结算异常 / 并发消耗）：如实给负数，交给界面解释
check('4150 → 4100 得 -50（不吞掉）', computeGained(4150, 4100, null) === -50);

// 快照缺失时退回上游给的数额
check('before=null 时用上游 gained', computeGained(null, 4150, 150) === 150);
check('after=null 时用上游 gained', computeGained(4000, null, 150) === 150);
check('两侧都缺、上游也没给 → null（不补 0）', computeGained(null, null, null) === null);
check('两侧都缺、上游给 0 → 0（上游明确说没发）', computeGained(null, null, 0) === 0);

// 上游给了值与差值并存时，**差值优先**——它是实测值，上游那个只是声明
check('差值优先于上游声明值', computeGained(4000, 4200, 150) === 200);

// 浮点噪声：整数账不该出现 150.00000000001
check('浮点噪声被收敛', computeGained(4144.95, 4294.95, null) === 150);

console.log('');
if (failures) {
  console.log(`✗ ${failures} 项失败`);
  process.exit(1);
}
console.log('✓ 全部通过');
