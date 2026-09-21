// src/admin/routes/keys.js - API Key 管理
const keysvc = require('../../keys');
const reqlog = require('../../reqlog');
const { sendJSON } = require('../router');

// 每个 key 的用量从请求日志聚合，而不是在 key 记录里累加计数：
// 累加会写坏（进程被杀就丢），日志是既成事实，重算总是对的。
function usageByKey(days = 30) {
  const since = Date.now() - days * 86400000;
  const { rows } = reqlog.read({ limit: 0, filter: (r) => r.ts >= since && r.key });
  const map = {};
  for (const r of rows) {
    const k = r.key;
    if (!map[k]) map[k] = { requests: 0, total_tokens: 0, failed: 0, last_at: 0 };
    map[k].requests++;
    map[k].total_tokens += r.total_tokens || 0;
    if (r.status >= 400 || r.status === 0) map[k].failed++;
    if (r.ts > map[k].last_at) map[k].last_at = r.ts;
  }
  return map;
}

function checkLists(body) {
  const problems = [];
  for (const field of ['ip_allowlist', 'model_allowlist']) {
    if (body[field] === undefined) continue;
    if (!Array.isArray(body[field])) {
      problems.push(`${field} 必须是数组`);
      continue;
    }
    if (field === 'ip_allowlist') {
      for (const item of body[field]) {
        const v = keysvc.validateCIDR(item);
        if (!v.ok) problems.push(v.reason);
      }
    }
  }
  return problems;
}

const routes = [
  {
    method: 'GET',
    path: '',
    handler: ({ res }) => {
      const usage = usageByKey(30);
      const list = keysvc.list().map((k) => ({
        ...k,
        usage: usage[k.name] || { requests: 0, total_tokens: 0, failed: 0, last_at: 0 },
      }));
      return sendJSON(res, 200, {
        keys: list,
        // 鉴权开关是环境变量，管理端只做展示与提醒
        require_key: process.env.DUMATE_REQUIRE_KEY === '1',
        days: 30,
      });
    },
  },
  {
    method: 'POST',
    path: '',
    handler: ({ res, body }) => {
      const problems = checkLists(body || {});
      if (body && body.name !== undefined && !String(body.name).trim()) {
        problems.push('名称不能只有空白');
      }
      if (problems.length) return sendJSON(res, 400, { error: problems.join('；') });

      const created = keysvc.create(body || {});
      require('../../admin/auth').audit('admin', 'key_create', created.key.name);
      // 明文 token 只在这里出现一次，之后无法再取回
      return sendJSON(res, 200, created);
    },
  },
  {
    method: 'PATCH',
    path: '/:id',
    handler: ({ res, body, params }) => {
      const problems = checkLists(body || {});
      if (problems.length) return sendJSON(res, 400, { error: problems.join('；') });
      const updated = keysvc.update(params[0], body || {});
      if (!updated) return sendJSON(res, 404, { error: 'key 不存在' });
      require('../../admin/auth').audit('admin', 'key_update', updated.name);
      return sendJSON(res, 200, updated);
    },
  },
  {
    method: 'DELETE',
    path: '/:id',
    handler: ({ res, params }) => {
      const ok = keysvc.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: 'key 不存在' });
      require('../../admin/auth').audit('admin', 'key_delete', params[0]);
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    // 校验 IP 白名单写法：写错一个 CIDR 会让这把 key 对所有来源都拒绝，
    // 所以在保存前就给明确提示，而不是等请求被拒时才发现
    method: 'POST',
    path: '/check-ip',
    handler: ({ res, body }) => {
      const items = Array.isArray(body && body.items) ? body.items : [];
      return sendJSON(res, 200, {
        results: items.map((i) => ({ item: i, ...keysvc.validateCIDR(i) })),
      });
    },
  },
];

module.exports = { routes };
