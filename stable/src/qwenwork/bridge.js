// src/qwenwork/bridge.js - 调官方 wasm 生成千问办公的数据面请求
//
// 千问办公 1.1.0 起，推理请求体必须由官方 qoder_auth_wasm_bg.wasm 生成
// （Encode=1）。本地自实现的编码能自洽但服务端不认，会回
// `400 Invalid agent chat JSON body`。所以只能调它。
//
// wasm_helper.mjs 是纯 Node ESM（零第三方依赖），这里用子进程调它的
// `infer` 模式：stdin 传 body（避免 Windows 命令行长度限制），
// stdout 收回 {url, body, headers}。
//
// 关于性能：目前是每请求 spawn 一次 Node。若实测成为延迟瓶颈，
// 改成长驻子进程（wasm_helper.mjs 已预留 serve 模式）只需改本文件，
// 上层 chat.js 不受影响。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const constants = require('./constants');
const wasmPath = require('./wasm-path');

const TIMEOUT_MS = 60000;
const HELPER = () => path.join(__dirname, 'wasm_helper.mjs');

let cached = null; // { file, at } —— 探测要扫目录，缓存结果

function helperPath() {
  const p = HELPER();
  if (!fs.existsSync(p)) {
    throw new Error(`wasm_helper.mjs 缺失（${p}）`);
  }
  return p;
}

/**
 * 生成一次推理请求。
 * @returns {{url:string, body:string, headers:object}}
 */
function prepareInfer({ uid, token, bodyJson, modelKey, machineId }) {
  const wasm = cached && cached.file ? cached.file : null;
  const env = { ...process.env };
  if (wasm) env.CB_QWENWORK_WASM = wasm;

  const tmp = path.join(os.tmpdir(), `qw-body-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, bodyJson, 'utf8');
  try {
    const out = execFileSync(
      process.execPath,
      [helperPath(), 'infer', uid, token, constants.GATEWAY, tmp, modelKey, machineId || ''],
      { encoding: 'utf8', timeout: TIMEOUT_MS, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    );
    const built = JSON.parse(out.trim());
    if (!built || !built.url || !built.body) {
      throw new Error('wasm 未产出可发送的请求');
    }
    return built;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略清理失败 */ }
  }
}

/** 预热：解析 wasm 路径，失败时给出可操作的提示 */
function warmup() {
  const detailed = wasmPath.resolveDetailed();
  if (!detailed) {
    throw new Error(
      '未找到 qoder_auth_wasm_bg.wasm。请确认已安装并登录千问办公，' +
      '或设置 DUMATE_QWENWORK_INSTALL / CB_QWENWORK_WASM 指向它。'
    );
  }
  cached = { file: detailed.file, at: Date.now() };
  return detailed;
}

module.exports = { prepareInfer, warmup, helperPath };
