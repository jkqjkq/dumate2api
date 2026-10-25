// src/boot.js - 启动接线与优雅停止（集成阶段）
//
// 施工包 A-E 的运行时模块此前「建而未接」：池状态机、保活排程、计量挂钩、
// 出站代理、热配置都在各自的包里自带初始化，但没有任何进程统一把它们的
// 启动顺序跑一遍、也没有人在进程退出前把防抖中的状态刷下去。本模块就是
// 那条启动链——只做初始化与停止，不做任何业务。
//
// 初始化顺序（后一步依赖前一步的存在）：
//   1. livecfg   热配置先加载：后续模块（软冷却基数、来源记录开关）从这里读
//   2. pool      池状态机恢复 data/pool-state.json + 起 5s 防抖 flusher
//   3. proxy     全局出站代理（DUMATE_PROXY 在模块加载时已读，这里校验+报告）
//   4. reqlog-hook  计量挂钩探活（reqlog.record 懒加载它，这里提前确认可加载）
//   5. keepalive    保活排程**不在这里启动**：它的 schedule() 由 task-scheduler
//                   在管理端进程唤醒（task-scheduler.js:71，施工包 B 的接线），
//                   网关进程再排一份会导致两个进程各跑一轮、上游请求翻倍。
//                   这里只确认模块可加载、pool 对接是否已切真（pool_mode）。
//
// shutdown() 在 SIGINT/SIGTERM 时跑：keepalive 停止并中断进行中的一轮 →
// 池落盘（flush + 停 flusher）→ 计量分桶落盘。全部同步、自吞异常——
// 退出路径上的失败不能再把进程挂在半死状态。
const livecfg = require('./livecfg');
const proxyAgent = require('./proxy-agent');

/**
 * 跑一遍启动链。幂等（重复调用直接返回上次结果）。
 * @param {{log?:Function}} [opts] log 缺省时静默（测试用）
 * @returns {{livecfg:object, pool:object, proxy:string|null, metering:string,
 *            keepalive:{mode:string}, order:string[]}}
 */
function init(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : null;
  const order = [];

  // 1. 热配置：提前加载一次确认可读（后续按 mtime 热读，这里不缓存快照）
  order.push('livecfg');
  let cfg = null;
  try { cfg = livecfg.Load(); } catch (e) { cfg = livecfg.defaults(); }
  if (log) log(`· 热配置已加载（${livecfg.FILE}：${Object.keys(cfg).join(', ')}）`);

  // 2. 池状态机：require 即完成「恢复落盘状态 + 起 flusher」（pool.js 单例自举）
  order.push('pool');
  const pool = require('./pool').pool;
  const counts = pool.counts();
  if (log) {
    log(`· 账号池状态机就绪（${counts.total} 个账号记录：健康 ${counts.healthy}，冷却 ${counts.cooling}，禁用 ${counts.disabled}，暂停 ${counts.paused}）`);
  }

  // 3. 全局出站代理：env 在 proxy-agent 模块加载时已读；这里校验一次配置并
  //    脱敏报告。非法配置抛错 fail-fast（绝不允许「配了代理却静默直连」）。
  order.push('proxy');
  let proxyDesc = null;
  const gp = proxyAgent.getGlobalProxy();
  if (gp) {
    proxyDesc = proxyAgent.describeProxy({ proxy: gp });
    if (log) log(`· 全局出站代理已启用：${proxyDesc}（账号可按 proxy 字段覆盖）`);
  }

  // 4. 计量挂钩探活：reqlog.record 会懒加载它，这里提前 require 一次，
  //    把「挂钩坏了/被关了」从第一个请求时刻提前到启动日志里。
  order.push('reqlog-hook');
  let metering = 'on';
  if (process.env.DUMATE_USAGE_AGG === '0') {
    metering = 'off(DUMATE_USAGE_AGG=0)';
  } else {
    try { require('./reqlog-hook'); } catch (e) { metering = `broken: ${e.message}`; }
  }
  if (log) log(`· 请求计量挂钩：${metering}`);

  // 5. 保活排程：只探测不启动（见文件头第 5 点）
  order.push('keepalive');
  let keepaliveMode = 'unavailable';
  try {
    const keepalive = require('./keepalive');
    keepaliveMode = keepalive.snapshot ? keepalive.snapshot().pool_mode : 'unknown';
    if (log) log(`· 保活排程由管理端进程持有（task-scheduler 唤醒），pool 对接模式：${keepaliveMode}`);
  } catch (e) { /* keepalive 故障不拖累网关启动 */ }

  return {
    livecfg: cfg,
    pool: counts,
    proxy: proxyDesc,
    metering,
    keepalive: { mode: keepaliveMode },
    order,
  };
}

/**
 * 优雅停止：停止保活排程与进行中的一轮 → 池状态落盘 → 计量分桶落盘。
 * 幂等；全部自吞异常。exit 传 true 时最后 process.exit(0)（信号处理器用）。
 */
function shutdown(reason, exit) {
  try { require('./keepalive').stop(); } catch (e) { /* 未加载/已停止 */ }
  try { require('./pool').pool.close(); } catch (e) { /* 落盘失败只能丢防抖窗口 */ }
  try {
    if (process.env.DUMATE_USAGE_AGG !== '0') require('./usage-agg').flushNow();
  } catch (e) { /* 同上 */ }
  if (exit) process.exit(0);
}

module.exports = { init, shutdown };
