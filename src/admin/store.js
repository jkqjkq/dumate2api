// src/admin/store.js - JSON / JSONL 持久化（对应参考 server/db.py）
const fs = require('fs');
const path = require('path');
const fileperm = require('../fileperm');
const jsonl = require('../jsonl');
const filelock = require('../filelock');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.join(ROOT, 'data');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

function dataPath(name) {
  return path.join(ensureDir(), name);
}

function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// 原子写：先落 .tmp 再 rename。直接 writeFileSync 一旦中途被 kill，
// 下次启动读到半个 JSON，用户表/配置全丢且没有可恢复的副本。
// 权限收紧（fileperm.js）：这里写的有口令哈希（admin-users.json）与会话
// 签名密钥（admin.secret），POSIX 创建即 0600，Windows 收紧目录 ACL。
function writeJSON(name, data) {
  const target = dataPath(name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fileperm.harden(tmp);
  filelock.renameAtomic(tmp, target);
  return data;
}

function appendJSONL(name, obj) {
  const target = dataPath(name);
  // 大小轮转（jsonl.js）：admin-audit / activity / task-runs 都是无界追加，
  // 管理端端口暴露时 login_failed 每次失败追加一行，可被匿名刷写
  jsonl.append(target, `${JSON.stringify(obj)}\n`);
  // 审计流水含来源 IP 与操作者，收窄到当前用户（Windows 上仅首次触发
  // 目录 ACL 收紧，开销可忽略）
  fileperm.harden(target);
}

function readJSONL(name, opts = {}) {
  const { limit = 0, filter = null } = opts;
  let rows = [];
  try {
    rows = fs.readFileSync(dataPath(name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (e) { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
  if (filter) rows = rows.filter(filter);
  return limit > 0 ? rows.slice(-limit) : rows;
}

module.exports = { DATA_DIR, ensureDir, dataPath, readJSON, writeJSON, appendJSONL, readJSONL };
