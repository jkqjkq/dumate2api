// 故意的语法错误模块 —— offthread 测试用：worker 里 require 它必须崩，
// 验证 run() 的 fallback 路径（worker 'error' 事件 → reject → fallback）。
module.exports = { this is not valid javascript !!! };
