// src/livecfg.js - 运行期可变配置（热生效快照）
//
// 参照 codebuddyManager workbuddy2api/internal/livecfg（快照 + 原子指针），
// 按 Node 单进程形态落地：模块单例持一个快照对象，Store **整体替换**新对象，
// Load 返回**私有拷贝**。跨进程（stable 网关 / dev / 管理端共用 data/）靠
// mtime 失效重读同步——与 keys.js / modelmap.js 同一套纪律，任一进程 PUT
// 后其余进程下一次 Load 即可见，不用重启。
//
// **审计教训（必须保持的纪律）**：集合类字段（hiddenModels）绝不能把内部
// 数组原样交出去——调用方对返回值的一次 push/splice 会泄漏给所有后续读者。
// Go 侧靠值拷贝天然隔离，JS 必须在 Load 里显式复制。Store 同理：
// 永远构造新快照，不原地改旧快照，读到半新半旧视图的调用方才会不存在。
//
// 只承载**读路径深、热改需求强**的少数字段，白名单式（不开放任意键）：
//   - recordClientInfo 请求日志是否记录调用来源（ip / ua）。消费者：
//     src/reqlog.js 的 record（本包接线，F6e）。默认 true——保持既有日志
//     形状，关掉是显式动作。
//   - hiddenModels     要隐藏的模型名（精确匹配、大小写敏感、裸名）。
//     消费接线点：/v1/models 与 /v1beta/models 的输出侧（server.js 调
//     applyHiddenModels）。dumate 无 cn/global 双域，裸名即全量 id，不做
//     codebuddy 的前缀归一化（N10 不应对齐）。
//   - softCooldownMs   429 软冷却基数（<=0 或缺省 = 用调用方内置默认）。
//     消费者：池状态机生产单例（pool.js 的 hotSoftCooldown 门控热读，
//     测试池不读——保持单测对机器真实配置不敏感）。
//
// 落盘 data/livecfg.json（tmp+rename 原子写 + filelock 跨进程互斥，与
// qoder/auth.js 同一套写纪律）。文件里只会有白名单键——磁盘上多出的键
// 容忍并丢弃（向前兼容），接口提交多出的键直接 400（防手滑写错键名
// 静默无效）。
const fs = require('fs');
const path = require('path');
const filelock = require('./filelock');

const FILE = 'livecfg.json';

const FIELDS = ['recordClientInfo', 'hiddenModels', 'softCooldownMs'];

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

function defaults() {
  return {
    recordClientInfo: true,
    hiddenModels: [],
    softCooldownMs: 0,
  };
}

/**
 * 白名单清洗。把任意输入收敛成合法快照片段：
 *   - 只认 FIELDS 里的键（strict=true 时多出的键抛错，false 时丢弃）
 *   - recordClientInfo：undefined/null → 缺省（不写）；其余按布尔
 *   - hiddenModels：字符串数组 → 逐项去空白 → 滤空 → 去重；非法输入 → []
 *   - softCooldownMs：非负有限数 → 取整；其余 → 0（=回退内置默认）
 * 返回的键集只含**输入里出现过的**白名单键（配合 Store 做 patch 合并）。
 */
function sanitize(patch, { strict = false } = {}) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(patch)) {
    if (!FIELDS.includes(key)) {
      if (strict) throw new Error(`未知配置键: ${key}（白名单: ${FIELDS.join(', ')}）`);
      continue;
    }
    const v = patch[key];
    if (key === 'recordClientInfo') {
      if (v == null) continue; // 未提供 = 不改这一项
      out.recordClientInfo = v === true;
    } else if (key === 'hiddenModels') {
      if (v == null) continue;
      if (!Array.isArray(v)) {
        if (strict) throw new Error('hiddenModels 必须是字符串数组');
        continue;
      }
      const seen = new Set();
      for (const item of v) {
        const s = String(item == null ? '' : item).trim();
        if (s) seen.add(s);
      }
      out.hiddenModels = [...seen];
    } else if (key === 'softCooldownMs') {
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        if (strict) throw new Error('softCooldownMs 必须是非负数字（毫秒）');
        continue;
      }
      out.softCooldownMs = Math.round(n);
    }
  }
  return out;
}

function mtimeOf() {
  try { return fs.statSync(filePath()).mtimeMs; } catch (e) { return 0; }
}

function readDisk() {
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (e) { return null; } // 不存在 / 坏文件都按默认，下次 Store 会整体重写
}

// 进程内缓存：{ mtime, snap }。mtime 对不上就重读——这就是跨进程热生效。
let cache = { mtime: -1, snap: defaults() };

function current() {
  const m = mtimeOf();
  if (m !== cache.mtime) {
    const patch = sanitize(readDisk()); // 磁盘宽容：未知键丢弃
    cache = { mtime: m, snap: { ...defaults(), ...patch } };
  }
  return cache.snap;
}

/**
 * 读当前配置。**返回私有拷贝**：顶层浅拷 + hiddenModels 数组复制，
 * 调用方随意改动都不影响下一个读者（审计教训，见文件头）。
 */
function Load() {
  const snap = current();
  return { ...snap, hiddenModels: [...snap.hiddenModels] };
}

/**
 * 提交一次变更（patch 语义：只传要改的键）。
 * 锁内 读当前 → 合并 → 白名单校验（strict，未知键抛错）→ 原子落盘 →
 * 换入新快照。**整体替换**，不原地改旧快照。
 * @returns {object} 提交后的完整配置（Load 形状，私有拷贝）
 */
function Store(patch) {
  return filelock.withLock(filePath(), () => {
    // 锁内先失效缓存再读：其他进程可能刚写过同一个文件
    cache = { mtime: -1, snap: defaults() };
    const base = current();
    const clean = sanitize(patch, { strict: true });
    const snap = { ...base, ...clean };
    fs.mkdirSync(dataDir(), { recursive: true });
    const target = filePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    cache = { mtime: mtimeOf(), snap };
    return Load();
  });
}

/**
 * 模型列表输出侧的隐藏过滤（hiddenModels 的消费接线点：/v1/models 与
 * /v1beta/models）。rows 是 {id}（OpenAI 形态）/ {name:'models/<id>'}（Google
 * 形态）/ 裸字符串，统一剥前缀取裸名后与 hiddenModels 精确比对（大小写敏感）。
 * 返回新数组不改入参；配置读不到时原样返回——隐藏是可选能力，故障不放大。
 */
function applyHiddenModels(rows) {
  let hidden;
  try { hidden = Load().hiddenModels; } catch (e) { return rows; }
  if (!Array.isArray(rows) || !hidden.length) return rows;
  const bare = (id) => (id.startsWith('models/') ? id.slice('models/'.length) : id);
  return rows.filter((r) => {
    const id = typeof r === 'string' ? r : String((r && (r.id != null ? r.id : r.name)) || '');
    return !hidden.includes(bare(id));
  });
}

/** 仅供测试：把进程内缓存打回「未读过」状态 */
function _resetForTest() {
  cache = { mtime: -1, snap: defaults() };
}

module.exports = { FILE, FIELDS, filePath, defaults, sanitize, Load, Store, applyHiddenModels, _resetForTest };
