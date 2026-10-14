// src/qwenwork/bridge.js - 千问办公的请求签名
//
// **默认走本地签名**（cosy-sign.js）：不需要客户端、不需要 wasm、
// 不用 spawn 子进程。官方 wasm 保留为可选退路
// （DUMATE_QWENWORK_USE_WASM=1）——万一上游改协议导致本地签名被拒，
// 装了客户端的机器可以一键切回。
//
// 历史：原实现**只有** wasm 一条路，每请求 execFileSync 起一个 Node 子进程
// 跑 wasm_helper.mjs，签名期间阻塞整个事件循环几百毫秒（见 index.js 的
// MAX_ATTEMPTS 注释）；且 wasm 是客户端二进制资产，客户端一卸载通道就死
// （2026-10-14 用户卸载千问办公后即如此）。当天实测本地签名被
// gateway.qwenwork.cn 正常接受，遂改为默认。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const constants = require('./constants');
const wasmPath = require('./wasm-path');
const localSign = require('./cosy-sign');

const TIMEOUT_MS = 60000;
const HELPER = () => path.join(__dirname, 'wasm_helper.mjs');

let cached = null; // { file, at } —— 探测要扫目录，缓存结果

/** 是否强制走官方 wasm。默认关——本地签名不需要任何外部文件 */
function useWasm() {
  return process.env.DUMATE_QWENWORK_USE_WASM === '1';
}

/** 当前实际使用的签名方式，供 /health 与排障展示 */
function signer() {
  return useWasm() ? 'wasm' : 'local';
}

function helperPath() {
  const p = HELPER();
  if (!fs.existsSync(p)) {
    throw new Error(`wasm_helper.mjs 缺失（${p}）`);
  }
  return p;
}

/** 走官方 wasm。只在 DUMATE_QWENWORK_USE_WASM=1 时进入 */
function prepareInferViaWasm({ uid, token, bodyJson, modelKey, machineId }) {
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

/**
 * 生成一次推理请求。
 * @returns {{url:string, body:string, headers:object}}
 */
function prepareInfer(opts) {
  if (!useWasm()) return localSign.prepareInfer(opts);
  return prepareInferViaWasm(opts);
}

/** 预热：本地签名无外部资源可预热；wasm 模式才需要解析 wasm 路径 */
function warmup() {
  if (!useWasm()) return { file: '(local sign)', version: 'local' };
  const detailed = wasmPath.resolveDetailed();
  if (!detailed) {
    throw new Error(
      '未找到 qoder_auth_wasm_bg.wasm。请确认已安装并登录千问办公，' +
      '或设置 DUMATE_QWENWORK_INSTALL / CB_QWENWORK_WASM 指向它；' +
      '或去掉 DUMATE_QWENWORK_USE_WASM=1 改用本地签名。'
    );
  }
  cached = { file: detailed.file, at: Date.now() };
  return detailed;
}

module.exports = { prepareInfer, warmup, helperPath, useWasm, signer };
