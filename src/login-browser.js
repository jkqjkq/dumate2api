// src/login-browser.js - 浏览器登录器（弹出独立窗口，登录后自动抓 cookie）
//
// 为什么需要它：百度搭子的登录态载体是浏览器 cookie，而且产品上没有面向
// 第三方程序的登录票据接口（实测过 qianfanproxy 下只有秒哒的 login_ticket，
// 且它校验跳转目标必须是 miaoda.cn）。读系统浏览器（Edge/Chrome）的 cookie
// 库也不行——运行中独占文件锁，且新版 Chromium 用 App-Bound Encryption。
//
// 所以让程序自己开一个受控的浏览器窗口：用户在里面登录，我们从**自己这个
// 窗口**读 cookie。这是唯一不依赖外部状态、也不碰用户浏览器数据的做法。
//
// 复用系统已装的 Edge/Chrome（playwright-core 不下载 Chromium），
// 因此只多了约 14MB 依赖而不是 130MB+。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const LOGIN_URL = 'https://login.bce.baidu.com/?redirect=' +
  encodeURIComponent('https://www.dumate.cn/app');
const TARGET_HOST = 'www.dumate.cn';

// 常见安装位置。优先 Edge（Windows 自带），再 Chrome。
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  const envPath = process.env.DUMATE_BROWSER_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 会话状态。同一时刻只允许一个登录流程——多个窗口同时登录会互相覆盖
// cookie，最后存下来的账号归属不明。
let session = {
  active: false,
  started_at: null,
  status: 'idle',   // idle | waiting | success | failed | cancelled
  message: '',
  cookie: null,
  profile: null,
  browserPath: null,
};

let ctx = null;
let pollTimer = null;

function snapshot() {
  return {
    active: session.active,
    status: session.status,
    message: session.message,
    started_at: session.started_at,
    // cookie 不通过接口回显，只在成功后由调用方取用
    has_cookie: !!session.cookie,
    profile: session.profile,
    browser_path: session.browserPath,
    login_url: LOGIN_URL,
  };
}

function cleanup() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const c = ctx;
  ctx = null;
  if (c) c.close().catch(() => {});
  session.active = false;
}

// 判断 cookie 是否已具备登录态：BDUSS 是百度登录的核心字段
function extractAuthCookie(cookies) {
  const forHost = cookies.filter((c) => {
    const d = (c.domain || '').replace(/^\./, '');
    return TARGET_HOST === d || TARGET_HOST.endsWith('.' + d) || d === 'baidu.com';
  });
  const hasBduss = forHost.some((c) => c.name === 'BDUSS' && c.value);
  if (!hasBduss) return null;
  // 拼成标准 Cookie 头。同名 cookie 以域更具体的为准。
  const byName = new Map();
  for (const c of forHost) {
    const prev = byName.get(c.name);
    if (!prev || (c.domain || '').length > (prev.domain || '').length) byName.set(c.name, c);
  }
  return [...byName.values()].map((c) => `${c.name}=${c.value}`).join('; ');
}

async function start(opts = {}) {
  if (session.active) {
    return { ok: false, error: '已有登录流程进行中，请先完成或取消' };
  }

  const exe = findBrowser();
  if (!exe) {
    return {
      ok: false,
      error: '未找到 Edge 或 Chrome。可设置 DUMATE_BROWSER_PATH 指定浏览器路径',
    };
  }

  session = {
    active: true,
    started_at: Date.now(),
    status: 'waiting',
    message: '已打开登录窗口，请在其中完成登录',
    cookie: null,
    profile: opts.name || '',
    browserPath: exe,
  };

  try {
    // 独立的用户数据目录：与用户日常浏览器完全隔离，登录态不会互相影响，
    // 也不会读到用户自己的浏览数据
    const userDataDir = path.join(
      process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data'),
      'browser-profile',
    );
    fs.mkdirSync(userDataDir, { recursive: true });

    ctx = await chromium.launchPersistentContext(userDataDir, {
      executablePath: exe,
      headless: false,
      // 不用固定 viewport，跟随窗口大小，避免页面被压成移动端布局
      viewport: null,
      args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 窗口被用户手动关掉时收尾，否则会一直显示「等待登录」
    ctx.on('close', () => {
      if (session.status === 'waiting') {
        session.status = 'cancelled';
        session.message = '登录窗口已关闭';
      }
      session.active = false;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    });

    // 轮询 cookie：登录成功后百度会写入 BDUSS。
    // 每 1.5 秒一次，避免过密；同时检查窗口是否还在。
    pollTimer = setInterval(async () => {
      if (!ctx) return;
      try {
        const cookies = await ctx.cookies();
        const ck = extractAuthCookie(cookies);
        if (ck) {
          session.cookie = ck;
          session.status = 'success';
          session.message = '登录成功，已获取凭证';
          cleanup();
        }
      } catch (e) {
        // 上下文已关闭，交给 close 事件处理
      }
    }, 1500);
    if (pollTimer.unref) pollTimer.unref();

    return { ok: true, ...snapshot() };
  } catch (e) {
    session.status = 'failed';
    session.message = e.message;
    session.active = false;
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    return { ok: false, error: e.message };
  }
}

// 取走成功的 cookie。取走即清空——同一份凭证不应被重复入库两次。
function takeCookie() {
  const c = session.cookie;
  session.cookie = null;
  return c;
}

function cancel() {
  if (!session.active && !ctx) return { ok: true };
  session.status = 'cancelled';
  session.message = '已取消';
  cleanup();
  return { ok: true };
}

module.exports = { start, cancel, snapshot, takeCookie, findBrowser, LOGIN_URL, extractAuthCookie };
