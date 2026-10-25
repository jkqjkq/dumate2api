// test/helpers/tmpdata.js - 测试用临时 data 目录与模块重载
//
// 网关的多个模块（modelmap.js / cors.js / fileperm.js / keys.js …）在
// **require 时**固化配置：`process.env.DUMATE_ADMIN_DATA`、
// `DUMATE_CORS_ORIGINS` 等在模块加载那一刻读一次存进模块级常量。
// 因此测试要注入隔离环境时必须遵循一个顺序：
//
//   1. 先设 env（指向临时目录或白名单值）
//   2. 再 require 被测模块
//   3. 同一进程内要换一套 env → reload() 清缓存后重新 require
//
// node --test 下每个 *.test.js 文件是独立子进程，文件之间天然隔离；
// 本 helper 只解决「一个文件内要测多套配置」的情况。

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 创建一次性临时目录（os.tmpdir 下，测试结束由调用方 cleanup）。
 * @param {string} tag 名称片段，便于在临时目录里辨认归属
 * @returns {{dir:string, file:(name:string)=>string, cleanup:()=>void}}
 */
function makeTmpData(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dumate-test-${tag || 'data'}-`));
  return {
    dir,
    file: (name) => path.join(dir, name),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 清掉目标模块的 require 缓存并重新 require —— 用于「同一进程内换 env
 * 再测一遍模块加载期行为」的场景。
 * @param {string} modulePath 被测模块路径（相对本文件或绝对路径均可）
 * @returns {unknown} 重载后的模块导出
 */
function reload(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

module.exports = { makeTmpData, reload };
