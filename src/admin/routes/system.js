// src/admin/routes/system.js - 网关与上游状态
const http = require('http');
const discovery = require('../../discovery');
const launcher = require('../../upstream-launcher');

const PROXY_PORT = parseInt(process.env.DUMATE2API_PORT || '9080', 10);

function probeJSON(port, path, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        timeout: 3000,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ ok: true, status: res.statusCode, data: data }); }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// 复用发现链路即可，不另造一套判定：三级降级各查一次，
// 让界面能回答「端口是怎么找到的」，而不只是报一个数字。
function discoveryTrail() {
  const cli = discovery.discoverViaCommandLine();
  const sockets = discovery.discoverViaListeningSockets();
  const trail = [];
  if (cli) trail.push({ method: 'command-line --port', port: cli, hit: false });
  for (const p of sockets) trail.push({ method: 'listening socket', port: p, hit: false });
  return { trail, cli };
}

const routes = [
  {
    method: 'GET',
    path: '/status',
    handler: async ({ req, res }) => {
      const proxy = await probeJSON(PROXY_PORT, '/health');
      const { trail } = discoveryTrail();

      let upstreamPort = proxy.ok && proxy.data ? proxy.data.upstream_port : null;
      let upstreamManaged = proxy.ok && proxy.data ? proxy.data.upstream_managed : false;
      let source = proxy.ok ? 'gateway /health' : 'unavailable';

      // 网关没起时自己走一遍发现，界面照样能显示上游在哪
      if (!proxy.ok) {
        const port = await discovery.discoverPort();
        if (port) {
          upstreamPort = port;
          source = 'admin direct discovery';
          upstreamManaged = port === discovery.MANAGED_PORT;
        }
      }

      for (const step of trail) {
        if (step.port === upstreamPort) step.hit = true;
      }

      const install = {
        dir: launcher.installRoot(),
        exe_exists: require('fs').existsSync(launcher.exePath()),
        config_exists: require('fs').existsSync(launcher.configPath()),
      };

      const profile = launcher.activeProfile();

      require('../router').sendJSON(res, 200, {
        admin: { port: req.socket.localPort, pid: process.pid },
        gateway: {
          port: PROXY_PORT,
          online: proxy.ok,
          upstream_port: upstreamPort,
          upstream_managed: upstreamManaged,
          source,
        },
        upstream: {
          port: upstreamPort,
          managed: upstreamManaged,
          managed_port: discovery.MANAGED_PORT,
          discovery: trail,
        },
        install,
        account: profile ? { name: profile.name, user_id: profile.userId } : null,
        versions: { node: process.version, admin: 'module-2' },
      });
    },
  },
];

module.exports = { routes };
