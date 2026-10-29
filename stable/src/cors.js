// src/cors.js - CORS 白名单辅助（fail-closed）
//
// 审计修复（P0-1）：此前网关与管理端所有响应都带 `Access-Control-Allow-Origin: *`。
// 网关即使只绑 127.0.0.1，用户浏览器里的任意网页也能向它发跨域 POST——
// preflight 被 `*` 放行、请求服务端照常执行（响应虽不可读，副作用全真实），
// 等于给匿名者开了一条盲 CSRF 烧积分的通道。而本网关的正常客户端
// （cc-switch / Codex CLI / 管理前端同源）根本不依赖 CORS，所以：
//
//   默认（未配置 DUMATE_CORS_ORIGINS）→ 不发任何 CORS 头，浏览器跨域请求
//   在 preflight 阶段就被拦下；同源与 CLI 客户端完全不受影响。
//
//   配置了白名单 → 仅回显命中的 Origin（`*.example.com` 支持子域通配）。
//
// fail-closed：配置里出现字面 `*` 按配置错误处理——打 WARN 并按未配置
// 处理，绝不退化回全开（`*` + 凭据正是本次要修掉的形态）。
//
// 用法：请求入口先调 headersFor(req) 一次，把结果挂在 res._cors 上；
// sendJSON / SSE writeHead 统一展开 `...(res._cors || {})`。

function parseAllowlist() {
  const raw = String(process.env.DUMATE_CORS_ORIGINS || '').trim();
  if (!raw) return [];
  const items = raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (items.includes('*')) {
    console.error(
      '[cors] DUMATE_CORS_ORIGINS 含 "*"：fail-closed，按未配置处理；如需放行请逐个列出 Origin（支持 *.example.com 子域通配）'
    );
    return [];
  }
  return items.map((s) => s.toLowerCase());
}

const allowlist = parseAllowlist();

function originAllowed(origin) {
  const o = String(origin).toLowerCase();
  return allowlist.some((rule) => {
    if (rule.startsWith('*.')) return o.endsWith(rule.slice(1)); // *.example.com → 以 .example.com 结尾
    return o === rule;
  });
}

// 请求入口调用一次。无 Origin 头（CLI/同源）返回空对象，响应头零变化。
function headersFor(req) {
  const origin = req.headers && (req.headers.origin || req.headers.Origin);
  if (!origin) return {};
  if (!allowlist.length || !originAllowed(origin)) {
    return { Vary: 'Origin' };
  }
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': String(origin),
  };
}

function allowlistSize() {
  return allowlist.length;
}

module.exports = { headersFor, allowlistSize };
