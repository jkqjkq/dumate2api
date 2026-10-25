// 懒重建测试的第二个计算目标：与 offthread-target.js 等价的极小实现。
// offthread 的通道按 modulePath 隔离——同一个文件里先用默认配置跑过的
// 通道已持有旧 worker，注入短空闲时长的行为测试必须用新路径才拿得到
// 以新 env spawn 的 worker。
module.exports = {
  echo: (x) => x,
  add: (a, b) => a + b,
};
