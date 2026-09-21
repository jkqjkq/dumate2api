// dumate2api - Port auto-discovery + upstream bootstrap for DuMate main-server
const { execFileSync } = require('child_process');
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

async function discoverPort() {
  const cliPort = discoverViaCommandLine();
  if (cliPort && (await probeChat(cliPort))) return cliPort;

  for (const p of discoverViaListeningSockets()) {
    if (await probeChat(p)) return p;
  }

  const known = await discoverViaKnownPorts();
  if (known) return known;

  try {
    const managed = await bootstrapManaged();
    if (managed) return managed;
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
  discoverViaListeningSockets,
  probeChat,
  MANAGED_PORT,
};