// src/admin/router.js - /api/admin/* 路由分发（对应参考 main.py 的 include_router）
const { currentUser } = require('./auth');

const routes = [];

function register(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, public: !!opts.public });
}

function mount(prefix, table) {
  for (const r of table) {
    register(r.method, prefix + r.path, r.handler, r);
  }
}

// 把注册的路径模式锚定到整串：不锚定的话 `/models/map` 会匹配
// `/models/map/reset`（子串命中），于是更具体的路由永远走不到，
// 请求被前一条带着空 body 处理掉。`:name` 段允许带参数。
function anchor(pattern) {
  if (pattern.startsWith('^')) return pattern;
  const escaped = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return `([^/]+)`;
      if (seg.startsWith('*')) return `(.*)`;
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return `^${escaped}/?$`;
}

function find(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(anchor(r.pattern));
    if (m) return { route: r, params: m.slice(1).map(decodeURIComponent) };
  }
  return null;
}

function unauthorized(res) {
  sendJSON(res, 401, { error: 'unauthorized' });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function handle(req, res, pathname) {
  const hit = find(req.method, pathname);
  if (!hit) {
    return sendJSON(res, 404, { error: 'not_found', path: pathname });
  }
  if (!hit.route.public) {
    const user = currentUser(req);
    if (!user) return unauthorized(res);
    req.user = user;
  }
  const body = req.method === 'GET' ? null : JSON.parse((await readBody(req)) || '{}');
  return hit.route.handler({ req, res, body, params: hit.params, user: req.user || null });
}

module.exports = { register, mount, handle, sendJSON, readBody };
