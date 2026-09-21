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
//   DUMATE_MIN_MAX_TOKENS  预算下限，默认 32768（0 = 关闭抬升/压制，只对非法入参兜底）
//   DUMATE_MAX_MAX_TOKENS  预算上限，默认 131072（0 表示不设上限）

const FLOOR = parseInt(process.env.DUMATE_MIN_MAX_TOKENS || '32768', 10);
const CEIL = parseInt(process.env.DUMATE_MAX_MAX_TOKENS || '131072', 10);

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

module.exports = { resolveMaxTokens, FLOOR, CEIL, DEFAULT_BUDGET };
