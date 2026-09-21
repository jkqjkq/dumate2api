// src/admin/iputil.js - 客户端来源 IP（对应参考 server/iputil.py）
//
// 管理端默认只监听 127.0.0.1，不存在可信反代，因此直接取 TCP 对端。
// 等到需要挂反代时再补 TRUST_PROXY 判定——现在写了就是死代码。
function clientIP(req) {
  const raw = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

module.exports = { clientIP };
