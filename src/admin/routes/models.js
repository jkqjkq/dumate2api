// src/admin/routes/models.js - 模型映射管理
const http = require('http');
const modelmap = require('../../modelmap');
const discovery = require('../../discovery');
const { sendJSON } = require('../router');

// 实测上游是否接受某个模型 ID。只发最小请求（1 token），
// 因为上游没有模型列表接口，只能靠这个探针回答「这个名字上游认不认」。
function probeModel(port, model, timeout = 15000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/qianfanproxy/v1/chat/completions',
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer nokey',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let upstreamError = '';
          if (res.statusCode >= 400) {
            try {
              const j = JSON.parse(data);
              upstreamError = (j.error && (j.error.message || j.error.code)) || j.error_message || '';
            } catch (e) { upstreamError = data.slice(0, 120); }
          }
          resolve({
            model,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            error: String(upstreamError).slice(0, 200),
          });
        });
      }
    );
    req.on('error', (e) => resolve({ model, ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ model, ok: false, status: 0, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

const routes = [
  {
    method: 'GET',
    path: '/map',
    handler: ({ res }) => {
      const cfg = modelmap.load();
      const upstream = new Set(cfg.upstream_models);
      return sendJSON(res, 200, {
        aliases: cfg.aliases,
        upstream_models: cfg.upstream_models,
        exposed: cfg.exposed,
        fallback: cfg.fallback,
        // 界面上要一眼看出哪些名字是上游原生、哪些只是别名
        entries: Object.keys(cfg.aliases).sort().map((name) => ({
          name,
          target: cfg.aliases[name],
          upstream_native: upstream.has(name),
          exposed: cfg.exposed.includes(name),
        })),
        defaults: {
          aliases: modelmap.DEFAULT_ALIASES,
          upstream_models: modelmap.DEFAULT_UPSTREAM,
          exposed: modelmap.DEFAULT_EXPOSED,
        },
      });
    },
  },
  {
    method: 'POST',
    path: '/map',
    handler: ({ res, body }) => {
      if (!body || typeof body !== 'object') {
        return sendJSON(res, 400, { error: '请求体必须是对象' });
      }
      const problems = [];
      if (body.aliases !== undefined) {
        if (typeof body.aliases !== 'object' || Array.isArray(body.aliases)) {
          problems.push('aliases 必须是对象');
        } else {
          for (const [k, v] of Object.entries(body.aliases)) {
            if (!String(k).trim()) problems.push('别名不能为空');
            if (!String(v || '').trim()) problems.push(`别名 ${k} 的目标为空`);
          }
        }
      }
      if (body.exposed !== undefined) {
        if (!Array.isArray(body.exposed) || !body.exposed.length) {
          problems.push('exposed 至少保留一个模型');
        }
      }
      if (body.upstream_models !== undefined) {
        if (!Array.isArray(body.upstream_models) || !body.upstream_models.length) {
          problems.push('upstream_models 至少保留一个模型');
        }
      }
      if (problems.length) return sendJSON(res, 400, { error: problems.join('；') });

      const saved = modelmap.save(body);
      require('../../admin/auth').audit('admin', 'model_map_save', '', JSON.stringify({
        aliases: Object.keys(saved.aliases).length,
        exposed: saved.exposed.length,
      }));
      return sendJSON(res, 200, { ok: true, ...saved });
    },
  },
  {
    method: 'POST',
    path: '/map/reset',
    handler: ({ res }) => {
      const cfg = modelmap.reset();
      require('../../admin/auth').audit('admin', 'model_map_reset');
      return sendJSON(res, 200, { ok: true, ...cfg });
    },
  },
  {
    // 探针：批量确认一批模型 ID 上游是否接受
    method: 'POST',
    path: '/probe',
    handler: async ({ res, body }) => {
      const models = Array.isArray(body && body.models) ? body.models.map(String) : [];
      if (!models.length) return sendJSON(res, 400, { error: 'models 不能为空' });
      if (models.length > 20) return sendJSON(res, 400, { error: '一次最多探测 20 个模型' });

      const port = await discovery.discoverPort();
      if (!port) return sendJSON(res, 502, { error: '未找到上游，无法探测' });

      // 并发探测：串行等 20 个模型最坏是 20×15s=300s，而前端 axios 超时
      // 只有 30s，浏览器早断了而服务端还在发请求。分池并发把最坏压到约
      // 15s，同时不至于一次性打爆上游。
      const CONCURRENCY = 5;
      const results = new Array(models.length);
      let cursor = 0;
      async function worker() {
        while (cursor < models.length) {
          const i = cursor++;
          results[i] = await probeModel(port, models[i]);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, models.length) }, worker),
      );
      return sendJSON(res, 200, { upstream_port: port, results });
    },
  },
  {
    // 网关对外暴露的模型列表（直接问网关，确认改动已生效）
    method: 'GET',
    path: '/gateway-list',
    handler: async ({ res }) => {
      const port = parseInt(process.env.DUMATE2API_PORT || '9080', 10);
      const out = await new Promise((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/v1/models', method: 'GET', timeout: 4000 },
          (r) => {
            let data = '';
            r.setEncoding('utf8');
            r.on('data', (c) => { data += c; });
            r.on('end', () => {
              try { resolve({ ok: true, data: JSON.parse(data) }); }
              catch (e) { resolve({ ok: false, error: 'invalid json' }); }
            });
          }
        );
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.end();
      });
      if (!out.ok) return sendJSON(res, 502, { error: out.error });
      return sendJSON(res, 200, out.data);
    },
  },
];

module.exports = { routes, probeModel };
