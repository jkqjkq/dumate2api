// dumate2api - Port auto-discovery + upstream bootstrap for DuMate main-server
const { execFileSync, execFile } = require('child_process');
const http = require('http');
const launcher = require('./upstream-launcher');

const UPSTREAM_PATH = '/api/qianfanproxy/v1/chat/completions';
const PROCESS_MATCH = 'dumate-main-server';
const KNOWN_PORTS = [8980, 52890];

// When we spawn the backend ourselves we pin it here so restarts are stable.
const MANAGED_PORT = parseInt(process.env.DUMATE_UPSTREAM_PORT || '8980', 10);

function runPS(script, timeout = 15000) {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout, windowsHide: true }
    );
  } catch (e) {
    return (e && e.stdout) ? String(e.stdout) : '';
  }
}

// 异步版 runPS。PowerShell 冷启动在本机实测要 5 秒以上，而同步调用会
// 阻塞整个 Node 事件循环——管理端调一次就能把服务端卡住几十秒，期间
// 所有请求（包括别的页面）都无响应。凡是「顺手看一眼进程状态」这类
// 非关键路径，一律走异步。
function runPSAsync(script, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? ((err.stdout) ? String(err.stdout) : '') : String(stdout || ''))
    );
  });
}

// 进程查询缓存。进程状态变化不频繁，而每次查询要付 PowerShell 启动成本，
// 缓存能把仪表盘重复刷新从「每次 15 秒」降到「每 10 秒最多一次」。
const PS_CACHE_TTL = 10000;
let cliCache = { at: 0, value: null };
let sockCache = { at: 0, value: null };

async function discoverViaCommandLineAsync() {
  if (Date.now() - cliCache.at < PS_CACHE_TTL) return cliCache.value;
  const out = await runPSAsync(
    `(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '${PROCESS_MATCH}' }).CommandLine`
  );
  let value = null;
  const m = out.match(/--port[=\s]+(\d+)/);
  if (m) {
    const port = parseInt(m[1], 10);
    if (port > 0 && port < 65536) value = port;
  }
  cliCache = { at: Date.now(), value };
  return value;
}

async function discoverViaListeningSocketsAsync() {
  if (Date.now() - sockCache.at < PS_CACHE_TTL) return sockCache.value;
  const out = await runPSAsync(
    `$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '${PROCESS_MATCH}' } | Select-Object -ExpandProperty ProcessId; ` +
    `if ($p) { (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $p -contains $_.OwningProcess } | ` +
    `Select-Object -ExpandProperty LocalPort -Unique) -join ',' }`
  );
  const value = out
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  sockCache = { at: Date.now(), value };
  return value;
}

function discoverViaCommandLine() {
  const out = runPS(
    `(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '${PROCESS_MATCH}' }).CommandLine`
  );
  const m = out.match(/--port[=\s]+(\d+)/);
  if (m) {
    const port = parseInt(m[1], 10);
    if (port > 0 && port < 65536) return port;
  }
  return null;
}

function discoverViaListeningSockets() {
  const out = runPS(
    `$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '${PROCESS_MATCH}' } | Select-Object -ExpandProperty ProcessId; ` +
    `if ($p) { (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $p -contains $_.OwningProcess } | ` +
    `Select-Object -ExpandProperty LocalPort -Unique) -join ',' }`
  );
  return out
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
}

function probeChat(port) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'model-text',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: UPSTREAM_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer nokey',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 3000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          done(data.includes('chat.completion') || res.statusCode === 400 || res.statusCode === 401);
        });
      }
    );
    req.on('error', () => done(false));
    req.on('timeout', () => { req.destroy(); done(false); });
    req.write(body);
    req.end();
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request(
      { host: '127.0.0.1', port, path: UPSTREAM_PATH, method: 'OPTIONS', timeout: 800 },
      (res) => { res.resume(); res.on('end', () => done(true)); }
    );
    req.on('error', () => done(false));
    req.on('timeout', () => { req.destroy(); done(false); });
    req.end();
  });
}

async function discoverViaKnownPorts() {
  for (const p of KNOWN_PORTS) {
    if (await probePort(p)) return p;
  }
  return null;
}

// Boot the Go backend headlessly. Auto mode only does this when nothing is
// already serving; `always` forces our own instance (ignores a running app).
async function bootstrapManaged() {
  const mode = process.env.DUMATE_AUTOSTART || 'auto';
  if (mode === 'off') return null;

  if (mode !== 'always' && (await probeChat(MANAGED_PORT))) return MANAGED_PORT;

  const info = await launcher.ensureUpstreamProcess(MANAGED_PORT);
  await launcher.waitForPort(MANAGED_PORT, '127.0.0.1', 30000);
  return info.port;
}

// 端口结果缓存。探测链最坏情况要跑两次 PowerShell（各 5-15 秒）+ 逐个
// 探活，而调用方（管理端每次刷新页面）要的是「现在能用哪个端口」，
// 不是每次重新完整走一遍降级链。命中缓存前仍会探活一次，确保端口真的还在。
const PORT_CACHE_TTL = 30000;
let portCache = { at: 0, value: null };

async function discoverPort(opts = {}) {
  const { force = false } = opts;

  if (!force && portCache.value && Date.now() - portCache.at < PORT_CACHE_TTL) {
    if (await probeChat(portCache.value)) return portCache.value;
  }

  // 先把已知端口探一遍：这是最便宜且最常见的命中路径（自建实例固定在
  // 8980），能省掉两次 PowerShell 调用
  const known = await discoverViaKnownPorts();
  if (known) {
    portCache = { at: Date.now(), value: known };
    return known;
  }

  const cliPort = await discoverViaCommandLineAsync();
  if (cliPort && (await probeChat(cliPort))) {
    portCache = { at: Date.now(), value: cliPort };
    return cliPort;
  }

  for (const p of await discoverViaListeningSocketsAsync()) {
    if (await probeChat(p)) {
      portCache = { at: Date.now(), value: p };
      return p;
    }
  }

  try {
    const managed = await bootstrapManaged();
    if (managed) {
      portCache = { at: Date.now(), value: managed };
      return managed;
    }
  } catch (e) {
    if (process.env.DUMATE_DEBUG) console.error('[discovery] bootstrap failed:', e.message);
  }

  return cliPort;
}

async function verifyPort(port) {
  if (!port) return false;
  return probeChat(port);
}

module.exports = {
  discoverPort,
  verifyPort,
  bootstrapManaged,
  discoverViaCommandLine,
  discoverViaCommandLineAsync,
  discoverViaListeningSockets,
  discoverViaListeningSocketsAsync,
  probeChat,
  MANAGED_PORT,
};