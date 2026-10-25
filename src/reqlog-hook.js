// src/reqlog-hook.js - 请求日志挂钩与归档查询（施工包 C）
//
// 两件事：
//   1. feed：reqlog.record 的计量挂钩入口（reqlog.js 懒加载本模块调用），
//      把每条请求喂给 usage-agg 内存分桶。聚合自吞异常，绝不影响埋点与
//      转发；DUMATE_USAGE_AGG=0 可整体关停。
//   2. readArchive：请求日志归档查询。原 reqlog.read 是整文件读入内存再
//      过滤——32MB 日志一次全量加载，日志越大查询越慢。这里按文件尾反向
//      分块扫、按落盘顺序倒序返回、收满或越过 from 界即停：大文件下查询
//      代价只与「返回条数 + 窗口深度」相关，与文件总大小无关。
//
// 归档文件：requests.jsonl（当前代）+ requests.jsonl.1（上一代，reqlog 轮转
// 产生，条目更旧）。返回顺序 = 落盘顺序的倒序，即时间倒序的良好近似
// （多进程并发追加时同毫秒内先后可能有出入）；需要精确时间窗时传 from/to
// 按 ts 过滤。从不上屏请求体/凭证——归档里本来也只有元数据。
const fs = require('fs');
const path = require('path');
const usageAgg = require('./usage-agg');

const ARCHIVE_FILE = 'requests.jsonl';
const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const CHUNK_BYTES = 256 * 1024;

/**
 * 计量挂钩：reqlog.record 每条请求都会调用。失败只少统计。
 */
function feed(entry) {
  if (process.env.DUMATE_USAGE_AGG === '0') return false;
  try {
    return usageAgg.addEntry(entry);
  } catch (e) {
    return false;
  }
}

/**
 * 归档查询：最近 N 条，最新在前。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]   返回条数，默认 200，钳到 2000（有界保证）
 * @param {number} [opts.offset]  跳过最新 offset 条（分页）
 * @param {Function} [opts.filter] (entry) => boolean，面板自定义过滤
 *   （如通道归属 channels.belongs）；与 reqlog.read 的 filter 同一习惯
 * @param {number} [opts.from]    只返回 ts >= from 的条目；越过即整段早停
 * @param {number} [opts.to]      只返回 ts <= to 的条目
 * @param {string} [opts.dir]     数据目录（测试注入用）
 * @returns {{ rows: object[], hasMore: boolean }}
 */
function readArchive(opts = {}) {
  let limit = Number(opts.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);
  const offset = Math.max(0, Number(opts.offset) || 0);
  const filter = typeof opts.filter === 'function' ? opts.filter : null;
  const from = Number(opts.from) || 0;
  const to = Number(opts.to) || 0;
  const dir = opts.dir || DATA_DIR;
  // 多收一条才能回答 hasMore；查到即停，不做全量计数
  const need = offset + limit + 1;
  const rows = [];
  for (const name of [ARCHIVE_FILE, `${ARCHIVE_FILE}.1`]) {
    if (rows.length >= need) break;
    const stopped = scanFileReverse(path.join(dir, name), (line) => {
      let e;
      try { e = JSON.parse(line); } catch (err) { return true; }
      if (!e || typeof e !== 'object') return true;
      const ts = Number(e.ts) || 0;
      // 落盘序近似时间序：碰到比 from 更早的条目，更旧的整段不再扫
      if (from && ts && ts < from) return false;
      if (to && ts && ts > to) return true;
      if (filter && !filter(e)) return true;
      if (rows.length >= need) return false;
      rows.push(e);
      return true;
    });
    if (stopped) break;
  }
  return {
    rows: rows.slice(offset, offset + limit),
    hasMore: rows.length > offset + limit,
  };
}

// 从文件尾反向逐行扫（最新在前）。按字节 \n 切分——UTF-8 多字节字符不含
// 0x0A，跨块边界切行不会切坏字符。visit 返回 false = 停止；
// 返回值 true = 因 visit 叫停，false = 整个文件扫完。
function scanFileReverse(file, visit) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return false; }
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, size)));
    let pos = size;
    let rem = null; // 更新一侧切出的行尾段（行首在更旧的未读字节里）
    while (pos > 0) {
      const len = Math.min(buf.length, pos);
      pos -= len;
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, pos + got);
        if (n <= 0) break;
        got += n;
      }
      if (got <= 0) break;
      const head = buf.subarray(0, got);
      const combined = rem && rem.length ? Buffer.concat([head, rem]) : Buffer.from(head);
      const nl = combined.indexOf(10);
      if (nl === -1) {
        // 整块无换行：都是某条超长行的一部分，继续向旧块拼接
        rem = combined;
        continue;
      }
      rem = Buffer.from(combined.subarray(0, nl));
      // 第一个 \n 之后的分段都完整；最后一段与上一块切出的行尾段融合，
      // 恰好拼成完整行
      const segs = [];
      let start = nl + 1;
      for (let i = combined.indexOf(10, start); i !== -1; i = combined.indexOf(10, start)) {
        segs.push(combined.subarray(start, i));
        start = i + 1;
      }
      segs.push(combined.subarray(start));
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i].toString('utf8').trim();
        if (s && visit(s) === false) return true;
      }
    }
    if (rem && rem.length) {
      const s = rem.toString('utf8').trim();
      if (s && visit(s) === false) return true;
    }
    return false;
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* 已关 */ }
  }
}

module.exports = { feed, readArchive, ARCHIVE_FILE };
