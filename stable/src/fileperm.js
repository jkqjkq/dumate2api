// src/fileperm.js - 凭证文件权限收紧（审计 P1-3 的最小化处理）
//
// data/ 下的账号文件就是全部上游权限的边界（accounts.js 头注释自认），
// 默认落盘权限却继承目录的宽松 ACL。这里做两层：
//   - POSIX：凭证文件创建即 0600（rename 保留权限）；harden() 再兜底 chmod
//     一次，覆盖「残留的旧 tmp 被复写」的情况；
//   - Windows：chmod 近乎无效，改用 icacls 把数据目录改成「显式授予当前
//     用户（含子对象继承）+ 断开父目录继承」。目录收紧后，新建的文件
//     （含原子写的 .tmp）自然继承收紧后的 ACL。每进程每个目录只做一次，
//     失败静默——尽力而为，不因权限收紧失败影响正常转发。
//
// 加固顺序必须是「先授予、后断继承」：反过来会把所有人（包括当前用户）
// 关在门外。grant 用 (OI)(CI) 让 ACE 传到文件与子目录。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const hardenedDirs = new Set();

function chmod0600(file) {
  try { fs.chmodSync(file, 0o600); } catch (e) { /* 尽力而为 */ }
}

function hardenDirWindows(dir) {
  const resolved = path.resolve(dir);
  if (hardenedDirs.has(resolved)) return;
  hardenedDirs.add(resolved);
  const user = process.env.USERNAME || process.env.USER;
  if (!user) return;
  const tryRun = (args) => {
    try { spawnSync('icacls', args, { stdio: 'ignore', timeout: 10000 }); }
    catch (e) { /* 尽力而为 */ }
  };
  tryRun([resolved, '/grant', `${user}:(OI)(CI)F`]);
  tryRun([resolved, '/inheritance:r']);
}

/**
 * 对即将 rename 的 tmp 文件收权限（rename 后权限随文件带到目标路径）。
 * Windows 上顺带收紧所在目录（每进程一次）。
 */
function harden(file) {
  if (process.platform === 'win32') hardenDirWindows(path.dirname(file));
  else chmod0600(file);
}

module.exports = { harden };
