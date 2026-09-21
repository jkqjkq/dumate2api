// src/reqlog.js - 请求埋点（网关侧）
//
// 目标：回答「今天用了多少 token、多少次请求、谁在调、成功率多少」。
// 上游不提供用量接口，客户端也不落库，所以只能在网关这一跳自己记。
//
// 落盘用 JSONL 追加：一次请求一行，崩了最多丢最后一行，不会像 JSON 数组
// 那样整体不可解析。写入是同步的——埋点失败绝不能影响正在转发的响应，
// 所以出错只吞掉。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = process.env.DUMATE_ADMIN_DATA || path.join(ROOT, 'data');
const FILE = 'requests.jsonl';
const MAX_BYTES = 32 * 1024 * 1024;

let disabled = false;

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* 已存在 */ }
}

// 单文件超限就轮转一次：留一份上一代用于排查，不无限增长
function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    const prev = `${file}.1`;
    try { fs.unlinkSync(prev); } catch (e) { /* 不存在 */ }
    fs.renameSync(file, prev);
  } catch (e) { /* 文件还不存在 */ }
}

function record(entry) {
  if (disabled) return;
  try {
    ensureDir();
    const file = path.join(LOG_DIR, FILE);
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (e) {
    // 只报一次，避免磁盘满时每请求刷屏
    if (!disabled) {
      disabled = true;
      console.error(`[reqlog] 埋点已停用: ${e.message}`);
    }
  }
}

// 从上游 usage 里取 token 数。OpenAI 风格是 prompt_tokens/completion_tokens，
// Anthropic 风格是 input_tokens/output_tokens，Google 是 promptTokenCount/
// candidatesTokenCount，三条路径共用这一个函数。
function pickUsage(u) {
  if (!u || typeof u !== 'object') return { input: 0, output: 0, total: 0 };
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? 0) || 0;
  const total = Number(u.total_tokens ?? u.totalTokenCount ?? 0) || (input + output);
  return { input, output, total };
}

// 从 SSE 文本里扫出 usage。流式响应没有单一的 usage 字段，
// 必须逐行解析 data: 负载，取最后一个带 usage 的块。
function usageFromSSE(text) {
  let best = { input: 0, output: 0, total: 0 };
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const u = j.usage || (j.message && j.message.usage) ||
        (j.response && j.response.usage) || j.usageMetadata;
      if (u) {
        const picked = pickUsage(u);
        if (picked.total || picked.input || picked.output) best = picked;
      }
    } catch (e) { /* 非 JSON 行跳过 */ }
  }
  return best;
}

// 从请求体里推断模型名与是否流式，供日志展示
function describeRequest(body) {
  let model = '';
  let stream = false;
  let messages = 0;
  try {
    if (body && typeof body === 'object') {
      model = body.model || '';
      stream = !!body.stream;
      const m = body.messages || (body.contents || []);
      messages = Array.isArray(m) ? m.length : 0;
    }
  } catch (e) { /* 忽略 */ }
  return { model, stream, messages };
}

function clientIP(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

// 读日志，最新的在前。limit 与 offset 都按行计。
function read(opts = {}) {
  const { limit = 50, offset = 0, filter = null } = opts;
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(LOG_DIR, FILE), 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    return { rows: [], total: 0 };
  }
  let rows = lines
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
  if (filter) rows = rows.filter(filter);
  const total = rows.length;
  rows = rows.reverse();
  // limit <= 0 表示不限：统计接口要拿全量窗口自己聚合，
  // 按 slice(offset, offset+limit) 处理会把它当成取 0 条。
  rows = limit > 0 ? rows.slice(offset, offset + limit) : rows.slice(offset);
  return { rows, total };
}

module.exports = { record, read, pickUsage, usageFromSSE, describeRequest, clientIP, LOG_DIR };
