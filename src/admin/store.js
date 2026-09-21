// src/admin/store.js - JSON / JSONL 持久化（对应参考 server/db.py）
const fs = require('fs');
const path = require('path');

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
function writeJSON(name, data) {
  const target = dataPath(name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return data;
}

function appendJSONL(name, obj) {
  fs.appendFileSync(dataPath(name), `${JSON.stringify(obj)}\n`, 'utf8');
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
