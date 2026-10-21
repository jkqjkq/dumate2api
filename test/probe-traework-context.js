// test/probe-traework-context.js - 实测 TRAE 模型的**服务端上下文硬限**
//
// 为什么需要这个脚本：上游模型表里的 context_window_tokens.dev 是**客户端
// 压缩阈值**，不是服务端上限。实测 deepseek-v4.1-flash / glm-5.3-flash 声明
// 200K，但 1,000,036 token 的输入照样回 200；而 Doubao-Seed-2.1-Turbo 声明
// 256K，260,051 通过、330,000 被拒（4026）。所以**每个模型要单独测**，
// 不能按平台统一值填，也不能拿声明值当上限。
//
// 用法：
//   node test/probe-traework-context.js <model> [tokens ...]
//   node test/probe-traework-context.js deepseek-v4.1-flash 300000 1000000
//
// 判据：流里出现 event:error 且 code=4026 即超限；否则以上游自报的
// usage.prompt_tokens 为准（它比本地估算可靠）。
//
// **会消耗真实额度**：输入 token 数 × 该模型倍率。1M 输入在 0.06 倍率模型上
// 约 60 credits，在 kimi-k3（1.83 倍率）上约 1830——先看管理端的倍率再测。
const chat = require('../src/traework/chat');
const authStore = require('../src/traework/auth');
const models = require('../src/traework/models');

// 固定句子的 token 密度实测约 4.5 字符/token，用它换算目标 token 数
const LINE = 'The quick brown fox jumps over the lazy dog. ';
const CHARS_PER_TOKEN = 4.5;

function buildText(tokens) {
  return LINE.repeat(Math.max(1, Math.round((tokens * CHARS_PER_TOKEN) / LINE.length)));
}

async function probe(auth, model, tokens) {
  const body = chat.buildBody({
    model,
    messages: [{ role: 'user', content: buildText(tokens) + '\n\n只回复两个字：收到' }],
    stream: true,
  }, model);
  const t0 = Date.now();
  const r = await chat.postStream(body, auth);
  if (!r.stream) return { ok: false, error: r.error || 'no stream' };
  const events = [];
  await chat.readStream(r.stream, (e) => events.push(e));
  const err = events.find((e) => e.event === 'error');
  const usage = events.find((e) => e.event === 'token_usage');
  return {
    ok: !err,
    code: err && err.data && err.data.code,
    message: err && err.data && err.data.message,
    promptTokens: usage && usage.data && usage.data.prompt_tokens,
    completionTokens: usage && usage.data && usage.data.completion_tokens,
    ms: Date.now() - t0,
  };
}

(async () => {
  const model = process.argv[2];
  if (!model) {
    console.log('用法: node test/probe-traework-context.js <model> [tokens ...]');
    const known = models.MEASURED_HARD_CONTEXT;
    console.log('已实测：');
    for (const k of Object.keys(known)) console.log(' ', k, '=>', known[k].max, '|', known[k].note);
    process.exit(0);
  }
  const auth = authStore.findUsable()[0];
  if (!auth) { console.error('没有可用的 TRAE 账号（需先登录）'); process.exit(1); }

  const targets = process.argv.slice(3).map(Number).filter((n) => n > 0);
  const list = targets.length ? targets : [300000, 1000000];
  for (const t of list) {
    const x = await probe(auth, model, t);
    const tag = x.ok ? 'PASS' : (x.code === 4026 ? 'LIMIT' : 'FAIL');
    console.log(`${model.padEnd(26)} target=${String(t).padStart(8)} ${tag.padEnd(5)} `
      + `prompt=${x.promptTokens ?? '-'} completion=${x.completionTokens ?? '-'} `
      + `${(x.ms / 1000).toFixed(1)}s${x.code ? ' code=' + x.code : ''}${x.message ? ' ' + x.message : ''}`);
  }
})();
