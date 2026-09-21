// src/admin/routes/auth.js - 登录 / 登出 / 当前用户 / 踢会话
const auth = require('../auth');
const { clientIP } = require('../iputil');
const { sendJSON } = require('../router');

function setSessionCookie(res, token) {
  const parts = [
    `${auth.COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${24 * 3600}`,
  ];
  // Secure 只在 https 下置位：管理端跑在 127.0.0.1 明文 http，
  // 加了浏览器会直接丢弃 cookie，表现为「登录成功但一刷新就掉线」。
  if (process.env.DUMATE_ADMIN_SECURE_COOKIE === '1') parts.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const value = parts.join('; ');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, value) : value);
}

function clearSessionCookie(res) {
  const parts = [`${auth.COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  const existing = res.getHeader('Set-Cookie');
  const value = parts.join('; ');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, value) : value);
}

const routes = [
  {
    method: 'POST',
    path: '/auth/login',
    public: true,
    handler: ({ req, res, body }) => {
      const ip = clientIP(req);
      const username = String((body && body.username) || '').trim();
      const password = String((body && body.password) || '');

      if (auth.loginBlocked(ip, username)) {
        auth.audit(username || 'anonymous', 'login_blocked', username, `ip=${ip}`);
        return sendJSON(res, 429, {
          error: 'too_many_attempts',
          retry_after: auth.lockRemaining(ip, username),
        });
      }

      const data = auth.users() || {};
      const user = data[username];
      if (!user || !auth.verifyPwd(password, user.hash)) {
        auth.recordFail(ip, username);
        auth.audit(username || 'anonymous', 'login_failed', username, `ip=${ip}`);
        const blocked = auth.loginBlocked(ip, username);
        return sendJSON(res, blocked ? 429 : 401, {
          error: blocked ? 'too_many_attempts' : 'bad_credentials',
          retry_after: auth.lockRemaining(ip, username),
        });
      }

      auth.clearFail(ip, username);
      const token = auth.issueToken(user.username, user.role);
      setSessionCookie(res, token);
      auth.audit(user.username, 'login', '', `ip=${ip}`);
      return sendJSON(res, 200, { username: user.username, role: user.role });
    },
  },
  {
    method: 'POST',
    path: '/auth/logout',
    public: true,
    handler: ({ req, res }) => {
      const user = auth.currentUser(req);
      clearSessionCookie(res);
      if (user) auth.audit(user.username, 'logout');
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    path: '/auth/me',
    handler: ({ req, res, user }) => sendJSON(res, 200, user),
  },
  {
    method: 'POST',
    path: '/auth/sessions/revoke',
    handler: ({ req, res, user }) => {
      // 递增 session_version：所有已签发的 token 带着旧版本号，立刻全部失效
      auth.revokeSessions(user.username);
      auth.audit(user.username, 'sessions_revoke', user.username);
      return sendJSON(res, 200, { ok: true });
    },
  },
];

module.exports = { routes, setSessionCookie, clearSessionCookie };
