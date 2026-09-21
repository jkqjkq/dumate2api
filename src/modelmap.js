// src/modelmap.js - 模型映射（单一来源）
//
// 之前模型信息散在三处：anthropic.js 的 MODEL_MAP、server.js 里硬编码的
// /v1/models 列表、以及上游实际接受的 ID。三者会各自漂移——实测上游只接受
// model-text / model-artifact-validate / glm-5，而映射表里的 claude-* 与
// gpt-* 全靠 mapModel 兜底转成 model-text 才能用，界面却把它们当成独立模型
// 列出来。
//
// 这里把它收敛成一份可编辑配置，落 data/model-map.json。网关进程与管理端是
// 两个进程，所以读盘按 mtime 失效而不是只在启动时读一次——否则管理端改完
// 必须重启网关才生效，界面无法解释。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const FILE = 'model-map.json';

// 与改造前 MODEL_MAP 完全一致的默认值：升级不改变既有行为
const DEFAULT_ALIASES = {
  'claude-3-5-sonnet-20241022': 'model-text',
  'claude-3-5-sonnet-latest': 'model-text',
  'claude-3-5-haiku-20241022': 'model-text',
  'claude-3-5-haiku-latest': 'model-text',
  'claude-sonnet-4-20250514': 'model-text',
  'claude-opus-4-20250514': 'model-text',
  'claude-3-opus-20240229': 'model-text',
  'claude-3-haiku-20240307': 'model-text',
  'model-text': 'model-text',
  'model-artifact-validate': 'model-artifact-validate',
  // glm-5 上游直接接受（实测 200），但原表没收录它，于是被兜底转成
  // model-text —— 一个可用模型就这样被静默丢弃了。补上自身映射。
  'glm-5': 'glm-5',
  'gpt-4o': 'model-text',
  'gpt-4o-mini': 'model-text',
  'gpt-4': 'model-text',
  'gpt-4-turbo': 'model-text',
  'o1': 'model-text',
  'o1-mini': 'model-text',
  'o3': 'model-text',
  'o3-mini': 'model-text',
  'gpt-5': 'model-text',
};

// 上游真正认识的 ID。其余名字必须经别名映射后才能用。
const DEFAULT_UPSTREAM = ['model-text', 'model-artifact-validate', 'glm-5'];

// /v1/models 对外暴露的条目，与改造前保持一致
const DEFAULT_EXPOSED = [
  'model-text',
  'model-artifact-validate',
  'glm-5',
  'claude-3-5-sonnet-20241022',
  'gpt-4o',
];

const DEFAULTS = {
  aliases: DEFAULT_ALIASES,
  upstream_models: DEFAULT_UPSTREAM,
  exposed: DEFAULT_EXPOSED,
  fallback: 'model-text',
};

let cache = { at: 0, mtime: 0, data: null };

function filePath() {
  return path.join(DATA_DIR, FILE);
}

function readDisk() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch (e) {
    return null;
  }
}

function mtimeOf() {
  try { return fs.statSync(filePath()).mtimeMs; } catch (e) { return 0; }
}

// 合并默认值：磁盘上只存改动过的字段也能工作，缺项回落到默认
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const aliases = (r.aliases && typeof r.aliases === 'object') ? r.aliases : {};
  return {
    aliases: { ...DEFAULT_ALIASES, ...aliases },
    upstream_models: Array.isArray(r.upstream_models) && r.upstream_models.length
      ? r.upstream_models.map(String)
      : DEFAULT_UPSTREAM.slice(),
    exposed: Array.isArray(r.exposed) && r.exposed.length
      ? r.exposed.map(String)
      : DEFAULT_EXPOSED.slice(),
    fallback: typeof r.fallback === 'string' && r.fallback ? r.fallback : DEFAULTS.fallback,
  };
}

function load() {
  const mtime = mtimeOf();
  if (cache.data && cache.mtime === mtime) return cache.data;
  const data = normalize(readDisk());
  cache = { at: Date.now(), mtime, data };
  return data;
}

function save(patch) {
  const current = load();
  const next = normalize({
    aliases: patch.aliases !== undefined ? patch.aliases : current.aliases,
    upstream_models: patch.upstream_models !== undefined ? patch.upstream_models : current.upstream_models,
    exposed: patch.exposed !== undefined ? patch.exposed : current.exposed,
    fallback: patch.fallback !== undefined ? patch.fallback : current.fallback,
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  cache = { at: Date.now(), mtime: mtimeOf(), data: next };
  return next;
}

function reset() {
  try { fs.unlinkSync(filePath()); } catch (e) { /* 本来就不存在 */ }
  cache = { at: Date.now(), mtime: 0, data: null };
  return load();
}

// 与改造前的 mapModel 行为一致：查不到就回落到 fallback
function mapModel(name) {
  const cfg = load();
  if (!name) return cfg.fallback;
  return cfg.aliases[name] || cfg.fallback;
}

module.exports = {
  DEFAULTS,
  DEFAULT_ALIASES,
  DEFAULT_UPSTREAM,
  DEFAULT_EXPOSED,
  filePath,
  load,
  save,
  reset,
  mapModel,
};
