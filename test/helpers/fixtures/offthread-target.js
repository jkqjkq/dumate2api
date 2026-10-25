// test/helpers/fixtures/offthread-target.js - offthread.js 测试的 worker 目标模块
//
// offthread.run(modulePath, fnName, args, fallback) 会在 worker 线程里
// require(modulePath) 并调用其导出函数。这个文件就是那个 modulePath：
// 纯函数、无副作用、结果可预测。worker 里 require 的是**本文件的绝对路径**
// （由测试用 require.resolve 传入），所以改这里不会影响其他测试。

module.exports = {
  add: (a, b) => a + b,
  echo: (x) => x,
  boom: () => { throw new Error('kaboom'); },
};
