// src/qwenwork/wasm-path.js - 定位官方 qoder_auth_wasm_bg.wasm
//
// 这个文件**不能**复制进仓库：它是千问办公客户端的二进制资产（289KB），
// 随客户端版本变化，且不是我们的产物。必须运行时从安装目录读。
//
// Buddy2api 自带的探测只找 <ProgramFiles>\QwenWorkCN，而实际安装常在带
// 中文/空格的两层目录里（如 <ProgramFiles>\<厂商目录>\qianwenWork\QwenWorkCN），
// 所以这里自己扫，并取**版本号最大的**目录——客户端是多版本并存的，
// 用旧版本的 wasm 签名会被服务端拒。
const fs = require('fs');
const path = require('path');

const BRAND_NAMES = ['QwenWorkCN', 'qianwenWork', 'qwenwork', 'QwenWork'];
const WASM_REL = ['resources', 'qoder-auth-wasm', 'qoder_auth_wasm_bg.wasm'];

function candidateRoots() {
  const roots = [];
  if (process.env.DUMATE_QWENWORK_INSTALL) roots.push(process.env.DUMATE_QWENWORK_INSTALL);
  for (const drive of ['C:\\', 'D:\\', 'E:\\']) {
    for (const pf of ['Program Files', 'Program Files (x86)']) {
      roots.push(path.join(drive, pf, 'QwenWorkCN'));
    }
  }
  // 厂商布局：Program Files 下还会再套（甚至两层）品牌目录
  for (const drive of ['C:\\', 'D:\\', 'E:\\']) {
    const pf = path.join(drive, 'Program Files');
    let l1 = [];
    try { l1 = fs.readdirSync(pf, { withFileTypes: true }); } catch (e) { continue; }
    for (const a of l1) {
      if (!a.isDirectory()) continue;
      for (const brand of BRAND_NAMES) roots.push(path.join(pf, a.name, brand));
      let l2 = [];
      try { l2 = fs.readdirSync(path.join(pf, a.name), { withFileTypes: true }); } catch (e) { continue; }
      for (const b of l2) {
        if (!b.isDirectory()) continue;
        for (const brand of BRAND_NAMES) roots.push(path.join(pf, a.name, b.name, brand));
      }
    }
  }
  return roots;
}

/** 目录名形如 1.1.0-26091701 → 可比较的数值排名 */
function versionRank(name) {
  const m = String(name).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? (+m[1] * 1e6 + +m[2] * 1e3 + +m[3]) : 0;
}

function resolve() {
  const explicit = process.env.CB_QWENWORK_WASM || process.env.QWENWORK_WASM;
  if (explicit && fs.existsSync(explicit)) return explicit;

  let best = null;
  for (const root of candidateRoots()) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cand = path.join(root, e.name, ...WASM_REL);
      if (!fs.existsSync(cand)) continue;
      const rank = versionRank(e.name);
      if (!best || rank > best.rank) best = { rank, file: cand, version: e.name };
    }
  }
  return best ? best.file : null;
}

/** 带版本信息，用于日志与 /health 展示 */
function resolveDetailed() {
  const explicit = process.env.CB_QWENWORK_WASM || process.env.QWENWORK_WASM;
  if (explicit && fs.existsSync(explicit)) return { file: explicit, version: 'explicit' };
  let best = null;
  for (const root of candidateRoots()) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cand = path.join(root, e.name, ...WASM_REL);
      if (!fs.existsSync(cand)) continue;
      const rank = versionRank(e.name);
      if (!best || rank > best.rank) best = { file: cand, version: e.name, rank };
    }
  }
  return best;
}

module.exports = { resolve, resolveDetailed, candidateRoots, versionRank };
