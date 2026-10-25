// src/sticky.js - 会话粘性绑定表（GAP F1 子项,独立可选;零依赖）
//
// 会话哈希 → 账号 uid 的绑定表:同一会话的请求尽量落到同一账号,多账号长会话
// （TRAE 上下文恢复成本高）不必每次换号重放上下文。
//
// 与 codebuddyManager internal/session 的差异:dumate 四通道均为无状态转发,
// 没有会话→账号的强绑定语义,粘性只是「尽量」——所以不需要上游会话校验,
// 只要一张内存表就够。绑定只在内存:重启丢失即重新分配,无恢复价值。
//
// 典型接法（集成阶段）:
//   const sticky = require('./sticky');
//   let uid = sticky.lookup(sessionKey);
//   if (uid && !pool.isHealthy(uid)) { sticky.unbind(sessionKey); uid = null; }
//   if (!uid) { uid = pool.pick(...); if (uid) sticky.bind(sessionKey, uid); }
//   // 保底拦截/冷却命中时解绑换号:sticky.unbind(sessionKey)
//
// 淘汰双策略:TTL 过期（会话本身有生命周期）+ LRU 容量上限（防长尾 key 把
// 表撑爆）。两者都只在 lookup/bind 时惰性执行,无后台定时器。
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 会话静默 30 分钟视为结束
const DEFAULT_MAX = 512;               // 绑定数上限,淘汰最久未用的

/**
 * @param {{ttlMs?:number, max?:number, now?:()=>number}} [opts]
 */
function createSticky(opts = {}) {
  const ttlMs = opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const max = opts.max > 0 ? opts.max : DEFAULT_MAX;
  const now = () => (typeof opts.now === 'function' ? opts.now() : Date.now());
  // Map 保持插入序:头部最旧、尾部最新,天然当 LRU 链用
  const map = new Map(); // key → { uid, at }

  function evictExpired(t) {
    // 全表扫描（≤ max 条）:lookup 命中会刷新 at,插入序不再保证 at 序,
    // 不能按序提前 break
    for (const [k, v] of map) {
      if (t - v.at > ttlMs) map.delete(k);
    }
  }

  function bind(key, uid) {
    const k = String(key || '');
    if (!k) return false;
    const t = now();
    evictExpired(t);
    map.delete(k); // 重新绑定时移到尾部（刷新 LRU）
    map.set(k, { uid: String(uid), at: t });
    while (map.size > max) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
    return true;
  }

  function lookup(key) {
    const k = String(key || '');
    const v = map.get(k);
    if (!v) return null;
    const t = now();
    if (t - v.at > ttlMs) {
      map.delete(k);
      return null;
    }
    // 命中 = 移到尾部（刷新 TTL + 严格 LRU:淘汰序按插入序,头部必是最久未用）
    map.delete(k);
    v.at = t;
    map.set(k, v);
    return v.uid;
  }

  function unbind(key) {
    return map.delete(String(key || ''));
  }

  function size() {
    evictExpired(now());
    return map.size;
  }

  function clear() {
    map.clear();
  }

  return { bind, lookup, unbind, size, clear };
}

module.exports = { createSticky, DEFAULT_TTL_MS, DEFAULT_MAX };
