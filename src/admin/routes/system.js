// src/admin/routes/system.js - 网关与上游状态
const http = require('http');
const discovery = require('../../discovery');
const launcher = require('../../upstream-launcher');

// 要观察的网关端口。默认 9080（稳定版），开发实例通过 DUMATE_ADMIN_GATEWAY_PORT
// 指向 9082——管理端与网关是两个独立进程，各自监听不同端口，不能让管理端
// 写死去看 9080，否则开发实例会显示稳定版的数字。
const PROXY_PORT = parseInt(
  process.env.DUMATE_ADMIN_GATEWAY_PORT || process.env.DUMATE2API_PORT || '9080',
  10,
);

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
// 全部走异步版本——PowerShell 冷启动 5 秒以上，同步调用会把管理端
// 整个事件循环卡住，期间所有页面都无响应。
async function discoveryTrail() {
  const cli = await discovery.discoverViaCommandLineAsync();
  const sockets = await discovery.discoverViaListeningSocketsAsync();
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

      let upstreamPort = proxy.ok && proxy.data ? proxy.data.upstream_port : null;
      let upstreamManaged = proxy.ok && proxy.data ? proxy.data.upstream_managed : false;
      let source = proxy.ok ? 'gateway /health' : 'unavailable';

      // 网关起了就直接用它的答案，不再跑发现链路：那两次 PowerShell 探测
      // 在本机实测合计要 20 秒以上，而结果对界面只是「端口是怎么找到的」
      // 这句说明——为一个展示字段付 20 秒延迟不值得。
      // 只有网关不可用时才真的需要自己去发现。
      let trail = [];
      if (proxy.ok) {
        trail = [{ method: 'gateway /health', port: upstreamPort, hit: true }];
      } else {
        const found = await discoveryTrail();
        trail = found.trail;
        const port = await discovery.discoverPort();
        if (port) {
          upstreamPort = port;
          source = 'admin direct discovery';
          upstreamManaged = port === discovery.MANAGED_PORT;
        }
        for (const step of trail) {
          if (step.port === upstreamPort) step.hit = true;
        }
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
        // 两个上游通道并列报出。搭子是本地 HTTP 上游（有端口），
        // 千问办公是进程内直连（无端口，靠 wasm + 登录态）。
        // 分开报是为了让界面能回答「qwen/ 请求会在哪一步失败」。
        channels: (() => {
          const out = {
            dumate: {
              id: 'dumate', label: '百度搭子', kind: 'http',
              port: upstreamPort, ready: !!upstreamPort, managed: upstreamManaged,
            },
          };
          try {
            const qw = require('../../qwenwork');
            const st = qw.status();
            let acct = {};
            try {
              const doc = require('../../qwenwork/credentials').decryptAuth();
              const u = doc.user || {};
              acct = {
                account: u.name || '', tier: u.tier || '',
                tokenExpiresAt: doc.expiresAt || null,
                refreshExpiresAt: doc.refreshTokenExpiresAt || null,
                refreshExpired: (() => {
                  const t = Date.parse(doc.refreshTokenExpiresAt || '');
                  return Number.isFinite(t) ? Date.now() >= t : false;
                })(),
              };
            } catch (e) { /* 登录态读不到就只报通道状态 */ }
            out.qwenwork = {
              id: 'qwenwork', label: '千问办公', kind: 'direct',
              ready: st.ready, wasm: st.wasm ? st.wasm.version : null,
              loggedIn: !!st.loggedIn, error: st.error || '',
              ...acct,
            };
          } catch (e) {
            out.qwenwork = { id: 'qwenwork', label: '千问办公', kind: 'direct', ready: false, error: e.message };
          }
          return out;
        })(),
      });
    },
  },
];

module.exports = { routes };
