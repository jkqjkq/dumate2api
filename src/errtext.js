// src/errtext.js - 把网络层/上游的原生错误串翻译成人话
//
// ============================================================
// 为什么需要它
//
// 账号的 `lastError` 此前直接存 `e.message`，于是界面上会出现
// `aborted`、`socket hang up`、`ECONNRESET` 这类 Node 原生错误名——
// 它们对开发是准确的，但对「我的账号怎么了」这个问题毫无信息量：
// 用户看到 `aborted` 无法判断是网络断了、上游挂了、还是账号废了。
//
// 收敛到一处的原因与 `web/src/utils/lastError.ts` 相同：qoder / qwenwork /
// traework / web-pool 四处都在写 lastError，各写一份翻译必然漂移，
// 会出现「同一个错误在两个通道叫两个名字」。
//
// ## 两层都要做，缺一不可
//
//   写入时（normalizeError）：新产生的错误立刻是人话
//   读取时（explainError）：**存量**记录也要看得懂
//
// 只做写入时，历史数据里的 `aborted` 会一直躺到下次失败才被覆盖——
// 而 lastError 恰恰只在成功时才清，一个不再使用的账号会永久显示旧串。
//
// ## 翻译的原则：保留原串，不替换
//
// 输出形如「上游连接中断（aborted）」——**括号里保留原始错误名**。
// 排查时靠它 grep 代码与比对日志；抹掉原始串等于毁掉排障线索。
// ============================================================

/**
 * Node / 网络层的原生错误名 → 中文说明。
 * 只列**实际出现过或极易出现**的，不追求穷举——匹配不上就原样返回，
 * 编一个不认识的错误的解释比不翻译更糟。
 */
const NET_ERRORS = [
  // Qoder 上游限流（2026-10-23~24 实测）：信封 code 10605 + subCode
  // RESOURCE_LIMIT + serviceAvailable:false 是**服务级**过载，换账号没用。
  // 两条都无锚（子串匹配）：信封串很长，错误码藏在嵌套 JSON 里。
  [/RESOURCE_LIMIT/i, '上游限流中（服务过载，稍后重试）'],
  // 读空闲（qoder/chat.js 的 read idle）：请求被上游排队挂起、先响应后沉默，
  // 网关等满 READ_IDLE_MS 主动断开——不掐的话要挂到中间层 360s 才报 aborted。
  [/qoder upstream read idle/i, '上游排队挂起，长时间无数据（限流，已主动断开）'],
  // 响应流在传完之前被掐断。上游主动断开、中间设备超时、进程被杀都会触发
  [/^aborted$/i, '上游连接中断'],
  [/^socket hang up$/i, '上游连接被挂断'],
  [/^socket close/i, '上游连接提前关闭'],
  [/^ECONNRESET$/i, '连接被上游重置'],
  [/^ECONNREFUSED$/i, '连接被拒绝（上游未监听）'],
  [/^ECONNABORTED$/i, '连接被中止'],
  [/^EHOSTUNREACH$/i, '主机不可达'],
  [/^ENETUNREACH$/i, '网络不可达'],
  [/^ENOTFOUND$/i, '域名解析失败'],
  [/^EAI_AGAIN$/i, '域名解析失败（DNS 临时故障）'],
  [/^ETIMEDOUT$/i, '连接超时'],
  [/^EPIPE$/i, '写入时连接已断开'],
  [/^EPROTO/i, '协议错误'],
  [/^ERR_STREAM_WRITE_AFTER_END$/i, '响应结束后仍在写入'],
  [/^ERR_STREAM_PREMATURE_CLOSE$/i, '流提前关闭'],
  [/^Premature close$/i, '流提前关闭'],
];

/** 本项目各处自行构造的超时串：统一成一种说法 */
const OWN_TIMEOUT = [
  [/upstream timeout/i, '上游响应超时'],
  [/^timeout$/i, '响应超时'],
];

/**
 * 翻译一条错误。匹配不到就**原样返回**（含空串）。
 *
 * @param {unknown} msg 原始错误串或 Error
 * @returns {string}
 */
function explainError(msg) {
  const raw = String(msg == null ? '' : (msg.message || msg));
  const s = raw.trim();
  if (!s) return '';

  // 读取侧会对已翻译过的存量值再翻一次：已带这段中文说明的就跳过——
  // 无锚的子串匹配（RESOURCE_LIMIT / read idle / upstream timeout）不跳的话，
  // 重翻会命中翻译结果里保留的原串，套娃成双重括号。
  for (const [re, text] of OWN_TIMEOUT) {
    if (s.includes(text)) continue;
    if (re.test(s)) return `${text}（${s}）`;
  }
  for (const [re, text] of NET_ERRORS) {
    if (s.includes(text)) continue;
    // 完全匹配或去掉 Node 前缀后匹配（Error: aborted → aborted）
    if (re.test(s) || re.test(s.replace(/^(Error|TypeError|FetchError)\s*:\s*/i, ''))) {
      return `${text}（${s}）`;
    }
  }
  // 解析失败等带冒号前缀的（"HTTP 502: ..."）保持原样——已经有信息量了
  return s;
}

/** 写入时调用：翻译 + 截断（与既有 lastError 的 200 字上限一致） */
function normalizeError(msg) {
  return explainError(msg).slice(0, 200);
}

module.exports = { explainError, normalizeError };
