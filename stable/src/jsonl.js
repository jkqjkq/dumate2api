// src/jsonl.js - 带大小轮转的 JSONL 追加（审计 P1-4）
//
// 匿名可达的埋点文件（积分游标、各通道积分归因、管理端审计）每请求追加
// 一行，且这些文件会被管理端读路径整文件同步解析——无轮转等于给了匿名者
// 一个「慢性磁盘放大器 + 远程拖慢管理端」的组合。这里统一处理：超上限先
// 把当前文件归档为 `.old`（保留一代，新的 .old 直接覆盖旧的），再追加。
// requests.jsonl 自带 32MB 轮转（reqlog.js），不在此列。
const fs = require('fs');

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function rotateIfNeeded(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size < maxBytes) return;
    const prev = `${file}.old`;
    try { fs.unlinkSync(prev); } catch (e) { /* 还没有 .old */ }
    fs.renameSync(file, prev);
  } catch (e) { /* 文件还不存在 */ }
}

function append(file, line, maxBytes = DEFAULT_MAX_BYTES) {
  rotateIfNeeded(file, maxBytes);
  fs.appendFileSync(file, line);
}

module.exports = { append, rotateIfNeeded, DEFAULT_MAX_BYTES };
