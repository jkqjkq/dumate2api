// dumate2api - 输出预算策略（单一来源）
//
// 上游 GLM 的思维链 (reasoning_content) 与正文 (content) 共用同一个
// max_tokens 预算。reasoning 长度不可控（实测同一提示词 57 - 8492 tokens
// 都有出现），因此客户端给的预算越小，正文越容易被吃光：
//
//   实测（model-text，同一提示词）
//   ------------------------------------------------------------------
//   max_tokens | reasoning | content | finish_reason
//   ------------------------------------------------------------------
//        150  | 150       | 0       | length        <- 完全空回答
//       1024  | 1024      | 0       | length        <- 完全空回答
//       2048  | ~1.5K     | 有      | stop
//       4096  | 57-4074   | 有      | stop
//       8192+ | 任意      | 有      | stop
//
// 客户端自带的 max_tokens 只作参考，代理统一抬到 FLOOR 之上，保证
// reasoning 无论怎么展开都还剩得下正文空间。
//
// 环境变量：
//   DUMATE_MIN_MAX_TOKENS  预算下限，默认 65536（0 = 关闭抬升/压制，只对非法入参兜底）
//   DUMATE_MAX_MAX_TOKENS  预算上限，默认 131072（0 表示不设上限）
//   DUMATE_QWENWORK_MIN_MAX_TOKENS  千问办公专用下限，默认 4096

// 下限取 65536 而非 32768：32768 会在「一次写多章 + 完整项目上下文」下被
// 思维链吃光。实测（Codex 真实会话，写 3 章小说）：
//   预算 32768 → reasoning 32768 / 正文 0，耗时 7.5 分钟，整轮空转
//   预算 65536 → 同任务 reasoning 峰值实测约 22000（88% → 34%），留出余量
// 上游硬上限是 131072（传 200000 会被拒：`max_tokens参数非法：限制数值范围[1,131072]`），
// 所以 65536 只用掉一半空间，仍有向上调整余地。
const FLOOR = parseInt(process.env.DUMATE_MIN_MAX_TOKENS || '65536', 10);
const CEIL = parseInt(process.env.DUMATE_MAX_MAX_TOKENS || '131072', 10);

// 千问办公的下限**远低于**搭子，这是实测得出的，不是为了省：
//   千问的 reasoning 与正文分开流，但**它同样吃 max_tokens**，
//   而且峰值远超早期估计。实测同一「继续写 3 章小说」任务：
//     max_tokens=4096  → reasoning 约 46000 字符，工具参数只剩 216 字符（写不出内容）
//     max_tokens=32000 → reasoning 收敛到 3700 字符，工具参数 8681 字符（正常写作）
//   reasoning 被预算卡住时，模型会陷入反复推演（纠结章节对应哪一天之类），
//   最后只吐一句话就结束——表现为「几秒就停、不按要求做」。
//   所以下限不能太小：4096 对写作类任务远远不够，取 16384 留足思考空间，
//   同时仍明显低于搭子的 32768（避免小请求被撑得过大）。
const QW_FLOOR = (() => {
  const n = parseInt(process.env.DUMATE_QWENWORK_MIN_MAX_TOKENS || '16384', 10);
  return Number.isFinite(n) && n >= 0 ? n : 16384;
})();

// TRAE Work 的下限：与千问同理（reasoning 与正文抢预算），
// 但它实测 reasoning 峰值更高（单次 138~195 token 级别，长任务可到千级），
// 取 16384 与千问一致——低于这个值长任务会被 reasoning 吃光正文。
const TW_FLOOR = (() => {
  const n = parseInt(process.env.DUMATE_TRAEWORK_MIN_MAX_TOKENS || '16384', 10);
  return Number.isFinite(n) && n >= 0 ? n : 16384;
})();

const DEFAULT_BUDGET = 32768;

function resolveMaxTokens(requested) {
  const n = Number(requested);
  let out = Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
  // FLOOR=0 表示关闭预算策略：只对缺失/非法入参兜底到默认值，
  // 客户端明确给出的值原样透传，不再抬升也不再压制。
  if (FLOOR > 0) out = Math.max(out, FLOOR);
  if (CEIL > 0) out = Math.min(out, CEIL);
  return out;
}

/**
 * 千问办公的预算。与搭子分开的原因见 QW_FLOOR 的注释：
 * 千问也要兜底（否则小预算直接截断正文），但下限低得多。
 * 传 0 表示完全不干预（保留逃生口）。
 */
function resolveQwenMaxTokens(requested) {
  const n = Number(requested);
  let out = Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
  if (QW_FLOOR > 0) out = Math.max(out, QW_FLOOR);
  if (CEIL > 0) out = Math.min(out, CEIL);
  return out;
}

/** TRAE Work 的预算。与千问同一套逻辑，下限独立可配 */
function resolveTraeworkMaxTokens(requested) {
  const n = Number(requested);
  let out = Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
  if (TW_FLOOR > 0) out = Math.max(out, TW_FLOOR);
  if (CEIL > 0) out = Math.min(out, CEIL);
  return out;
}

module.exports = {
  resolveMaxTokens,
  resolveQwenMaxTokens,
  resolveTraeworkMaxTokens,
  FLOOR,
  QW_FLOOR,
  TW_FLOOR,
  CEIL,
  DEFAULT_BUDGET,
};
