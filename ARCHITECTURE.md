# dumate2api 架构与代码详解

> 本文描述的是**当前仓库实际实现**，所有行为结论均来自实测。
> 代码规模：`server.js` 485 行 / `discovery.js` 155 行 / `anthropic.js` 140 行 / `upstream-launcher.js` 103 行。
> 零第三方依赖，仅用 Node.js 内置 `http` / `net` / `child_process` / `fs` / `path`。

---

## 1. 这个项目解决什么问题

百度搭子（DuMate）桌面客户端内部跑着一个 Go 后端 `dumate-main-server.exe`，它暴露了一个**本地 OpenAI 兼容端点**：

```
http://127.0.0.1:<动态端口>/api/qianfanproxy/v1/chat/completions
```

但这个端点有三个问题，导致 Codex CLI / Claude Code 无法直接用：

| 问题 | 表现 | 本项目的解决 |
|---|---|---|
| 端口动态 | 每次启动端口都变，客户端无法写死 | `discovery.js` 三级发现 |
| 协议只有 OpenAI | Claude Code 说 Anthropic 协议 | `anthropic.js` 双向翻译 |
| 必须开着客户端 | Electron GUI 占资源、开机不自启 | `upstream-launcher.js` 无 GUI 拉起 |

于是本项目是一个**协议网关 + 进程管理器**，位置如下：

```
Codex CLI ──── OpenAI ────┐
                          ├──→ dumate2api (:9080) ──→ dumate-main-server (:8980) ──→ 百度千帆
Claude Code ─ Anthropic ──┘
```

关键设计取舍：**代理不做任何鉴权，也不接触凭证**。
它只是把请求转发给已登录的本地后端，凭证（cookie）始终留在磁盘上由 Go 后端自己读。

---

## 2. 模块划分与职责

```
dumate2api/
├── src/
│   ├── server.js             # HTTP 网关 + 路由 + OpenAI 透传 + SSE 转译
│   ├── discovery.js          # 上游端口发现（三级降级）+ 引导启动
│   ├── upstream-launcher.js  # 无 GUI 拉起 Go 后端（注入登录态环境变量）
│   ├── anthropic.js          # Anthropic ↔ OpenAI 双向翻译 + 模型名映射
│   ├── google.js             # Google Generative Language ↔ OpenAI 翻译
│   ├── responses.js          # OpenAI Responses API ↔ Chat Completions 翻译（Codex CLI）
│   └── budget.js             # 输出预算策略（三入口共用）
├── test/
│   ├── mock-upstream.js      # 假上游，用于离线自测
│   ├── smoke.js              # 32 项断言的回归测试
│   ├── verify-ccswitch.js    # 端到端验证（Codex / Claude 两条路径）
│   └── probe-oai.js / probe-anth.js  # 单路径手动探针
├── start.bat / stop.bat / restart.bat
└── README.md
```

依赖方向是单向的，无循环：

```
server.js ──→ discovery.js ──→ upstream-launcher.js
    ├──────→ anthropic.js ──→ budget.js
    ├──────→ google.js ─────→ budget.js
    └──────→ responses.js ──→ budget.js + anthropic.js(mapModel)
```

---

## 3. `server.js`：HTTP 网关

### 3.1 路由表

请求进来先处理 `OPTIONS` 预检（CORS 全放行），然后按 `url`（去掉 query）精确匹配：

| 路径 | 方法 | 处理函数 | 说明 |
|---|---|---|---|
| `/health` `/ping` | GET | 内联 | 返回 `{status, upstream_port, upstream_managed}` |
| `/v1/models` | GET | `handleOpenAIModels` | 静态列表 |
| `/v1/chat/completions` | POST | `handleOpenAIChat` | **透传**，仅改模型名与预算 |
| `/v1/responses` 或 `/responses` | POST | `handleOpenAIResponses` | **全量翻译**（Responses ↔ chat），Codex CLI 用 |
| `/v1/messages` 或 `/messages` | POST | `handleAnthropicMessages` | **全量翻译** |
| `/api/v1/messages` | POST | 同上 | 兼容变体 |
| `.../count_tokens` | POST | `handleAnthropicCountTokens` | 估算，供 Claude Code 预算用 |

> **为什么 `/messages` 要同时接受带和不带 `/v1`？**
> 这是实测踩出来的坑：Claude Code 打的是**裸路径** `/messages`，
> 而早期版本只认 `/v1/messages`，直接 404。现在两者都收。

未匹配的路径统一返回 404，外层 `try/catch` 兜 500。

### 3.2 上游缓存与重发现

```js
const DISCOVERY_INTERVAL = 30000;
```

`ensureUpstream()` 的逻辑：

1. 若已缓存端口且距上次发现 <30s → **直接复用**，零开销
2. 否则调用 `discoverPort()` 重新发现
3. 若发现失败但**有旧缓存** → 继续用旧值（上游临时抖动不至于让代理失效）
4. 两者都没有 → 抛错，由调用方转 502

这个"失败时沿用旧值"的策略是刻意的：DuMate 后端偶尔重启，硬失败会导致整条链路中断。

### 3.3 OpenAI 路径：最小干预透传

`handleOpenAIChat` 只做两件事，然后原样转发：

```js
reqBody.model = mapModel(reqBody.model);        // 模型名映射
reqBody.max_tokens = resolveMaxTokens(reqBody.max_tokens);  // 预算兜底（budget.js）
```

响应完全不改：流式用 `upstreamRes.pipe(res)` 直接管道，非流式收集后原样写回。
**不重打包 JSON**，所以新增字段（如 `completion_tokens_details`）会自动透传。

### 3.4 请求转发的一个细节

`forwardToUpstream` 有个特殊设计：出错时它**不是抛异常**，而是给 callback 传一个假响应对象：

```js
req.on('error', (err) => {
  callback({ fakeResponse: true, statusCode: 502, ... });
});
```

这样调用方可以用统一的 `if (upstreamRes.fakeResponse)` 分支处理，
不必在 callback 内外各写一套错误处理。是代码简化，不是 hack。

### 3.5 输出预算兜底（重要）

这是本项目**最关键的一个修正**，两个入口都做了：

三个入口（OpenAI / Anthropic / Google）都调用 `src/budget.js` 的同一个函数：

```js
// src/budget.js —— 预算策略单一来源
const FLOOR = parseInt(process.env.DUMATE_MIN_MAX_TOKENS || '32768', 10);
const CEIL  = parseInt(process.env.DUMATE_MAX_MAX_TOKENS || '131072', 10);
function resolveMaxTokens(requested) { /* 客户端值只作参考，钳到 [FLOOR, CEIL] */ }
```

**原因（实测）**：GLM 的思维链（reasoning）和正文**共用同一个 `max_tokens` 预算**，
且 reasoning 长度不可控 —— 同一提示词实测在 57 ~ 8492 tokens 之间浮动。因此：

| 客户端传的 max_tokens | 实测结果 |
|---|---|
| 150 | reasoning 吃掉全部 150 → 正文 `""`，`stop_reason=max_tokens` |
| 1024 | reasoning 吃掉全部 1024 → 正文 `""` |
| 2048 / 4096 | 多数正常，但 reasoning 峰值 4000+ 时正文被截断在半句 |
| 32768 | 实测稳定，正文完整返回 |

Claude Code 默认就传很小的值（150 / 1024 这类），不兜底就会拿到空回答或半句截断
（客户端表现为「能快就停」）。下限取 32768 而不是 4096，是因为 4096 仍在
reasoning 的实测峰值范围内，不能可靠覆盖。

---

## 4. `anthropic.js`：协议翻译层

### 4.1 模型名映射

```js
function mapModel(name) {
  if (!name) return 'model-text';
  return MODEL_MAP[name] || 'model-text';   // 未收录一律兜底
}
```

`MODEL_MAP` 收录了 Claude 系列（sonnet/haiku/opus 各版本）和 OpenAI 系列（gpt-4o/o1/o3/gpt-5），
**全部指向 `model-text`**，只有 `model-artifact-validate` 直通。

上游只暴露这两个真实模型，传别的名字会硬性报错：

```
model `model-ultra` does not exist. api not registered.
```

所以"兜底到 `model-text`"不是偷懒，而是**唯一可行的容错**。

### 4.2 请求方向：Anthropic → OpenAI

处理三种 Anthropic 特有结构：

| Anthropic 输入 | 转为 |
|---|---|
| `system`（字符串或块数组） | 一条 `{role:'system'}` 消息 |
| `content` 块数组中的 `text` | 拼接为纯文本 |
| `tool_use` | `[Tool Use: 名字]\n` + JSON |
| `tool_result` | `[Tool Result]\n` + 内容 |
| `image` | `[Image content - not supported]` 占位 |
| `stop_sequences` | OpenAI 的 `stop` |

**说明**：工具调用被降级成纯文本。DuMate 上游不支持 function calling / tool_use，
这是能力边界导致的降级，不是实现缺陷。图像同理。

### 4.3 响应方向：OpenAI → Anthropic

```js
if (message.reasoning_content) content.push({ type: 'thinking', thinking: ... });
if (message.content)             content.push({ type: 'text',    text: ... });
```

即把上游的思维链映射成 Anthropic 的 `thinking` block，正文映射成 `text` block。

`mapFinishReason` 的对应关系：

| OpenAI | Anthropic |
|---|---|
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| 其他 | `end_turn` |

### 4.4 SSE 流式转译：状态机

`translateStreamToAnthropic` 把 OpenAI 的 `data: {...}` 流逐块转成 Anthropic 事件。
它是一个**小块状态机**，维护：

```js
let blockIndex = -1;          // 当前 content block 序号
let currentBlockType = null;  // 'thinking' | 'text'
let inputTokens = 0, outputTokens = 0;
let lastFinishReason = null;  // 延后到流末尾再发
```

**块切换规则**：当收到的 delta 类型与当前块类型不同时，先 `content_block_stop` 旧块，
再 `content_block_start` 新块。这保证 `thinking` 和 `text` 不会混在一个块里。

**事件顺序（Anthropic 规范要求，也是实测修正过的）**：

```
message_start
  content_block_start (thinking)  → content_block_delta ×N → content_block_stop
  content_block_start (text)      → content_block_delta ×N → content_block_stop
message_delta        ← 带 usage
message_stop
```

> 早期版本在收到 `finish_reason` 时立刻发 `message_delta`，
> 导致 `message_delta` 出现在 `content_block_stop` **之前**，顺序违规。
> 现在改成只记录 `lastFinishReason`，等流结束统一补发——既修正顺序，也保证只发一次。

**token 用量**：请求时带上 `stream_options: {include_usage: true}`，
上游会在末尾补一个 `choices: []` + `usage` 的块。代理捕获后填进 `message_delta`。
实测真上游**确实支持**该参数（返回真实的 84/22 等），不是靠估算。

### 4.5 `count_tokens`

Claude Code 会先调这个端点做上下文预算。DuMate 没暴露分词器，
所以用 `字节数 / 4` 估算：

```js
function estimateTokens(value) { ... Math.ceil(value.length / 4) ... }
```

文档里明确标注了这是**估算值不是精确值**——够客户端算预算不报错，但不能当准。

---

## 5. `discovery.js`：端口发现（三级降级）

DuMate 后端的端口是动态分配的，客户端写不死。发现顺序如下：

```
① 读进程命令行 --port=NNNN
        ↓ 探测失败
② 读该进程实际监听的 socket 端口
        ↓ 探测失败
③ 扫描已知端口 [8980, 52890]
        ↓ 探测失败
④ 自己拉起后端（bootstrapManaged）
```

前两级都用 PowerShell：

```js
execFileSync('powershell', ['-NoProfile','-NonInteractive','-Command', script], {...})
```

（用 `execFileSync` + 参数数组而非拼字符串，避免注入与转义问题。）

**每一级候选端口都要过 `probeChat()`** ——发一个 `max_tokens:1` 的真实请求，
确认返回体含 `chat.completion`。
这一点很重要：只判断"端口通不通"会误判，因为本机可能有别的服务占用同端口。

### 第 ④ 级：引导启动

```js
async function bootstrapManaged() {
  const mode = process.env.DUMATE_AUTOSTART || 'auto';
  if (mode === 'off') return null;
  if (mode !== 'always' && (await probeChat(MANAGED_PORT))) return MANAGED_PORT;
  const info = await launcher.ensureUpstreamProcess(MANAGED_PORT);
  await launcher.waitForPort(MANAGED_PORT, '127.0.0.1', 30000);
  return info.port;
}
```

三种模式：

| `DUMATE_AUTOSTART` | 行为 |
|---|---|
| `auto`（默认） | 没有可用实例时才拉起 |
| `always` | 总是自己拉起，忽略已运行的客户端 |
| `off` | 只用已有实例，绝不自己启动 |

---

## 6. `upstream-launcher.js`：无 GUI 拉起后端

这是整个项目**唯一的逆向成果**，也是它不需要开 DuMate 界面的原因。

### 6.1 问题

直接跑 `dumate-main-server.exe` 会退出码 1：

```
ERROR runtime login context init failed: loginMode is required
```

因为登录态平时由 Electron 通过 IPC 注入。

### 6.2 解法

在二进制里搜字符串，发现它支持从环境变量读登录上下文：

```
DUMATE_LOGIN_MODE          ← 触发 env 路径
DUMATE_LOGIN_USER_ID       ← bceUserId
DUMATE_LOGIN_USER_NAME     ← displayName（装饰性）
DUMATE_LOGIN_BCE_ACCOUNT_ID
```

账户信息从 Electron 存的位置读：

```
%APPDATA%\qianfan-desktop-app\auth.json
  └─ accountProfiles[]           # 所有登录过的账号
  └─ activeProfileId             # 当前激活的那个
```

`activeProfile()` 优先取 `activeProfileId` 对应的 profile，
找不到就退化为 `lastLogin` 最大的那个。

然后 spawn：

```js
const child = spawn(exe, args, { env, cwd: ..., stdio: 'ignore', windowsHide: true });
```

参数：`-c <config.yml> -port 8980`（配置文件存在时才加 `-c`）。

### 6.3 边界

- **凭证本身不由本项目处理**。cookie 仍在 `auth.json` 里，由 Go 后端自己读。
- 因此 **cookie 过期后必须打开一次 DuMate 客户端重新登录** —— 这个绕不过去。
- `waitForPort` 用 TCP 连接轮询（300ms 一次，最长 30s）确认后端真的起来了，而不是盲等。

---

## 7. 关键逆向结论汇总

| 发现 | 证据 |
|---|---|
| 本地端点路径 | `/api/qianfanproxy/v1/chat/completions` |
| 鉴权 | `Authorization: Bearer nokey`（后端不校验 key，靠 DuMate 登录态） |
| 无 GUI 启动所需环境变量 | `DUMATE_LOGIN_MODE=standalone` 等 4 个 |
| 端口参数 | `-port N`（也有 `-proxy-port`，未使用） |
| 真实模型只有两个 | `model-text`、`model-artifact-validate`；其他名报 404 |
| 没有 `/responses` 路由 | 上游实测 404 `dumate api not registered` → 由 `src/responses.js` 在代理侧翻译（Codex 0.155 只认 `wire_api="responses"`） |
| 思考强度不可调 | `reasoning_effort` 各档 reasoning token 为 31/31/19/31，无差异 |
| 思维链关不掉 | GLM 恒定输出 reasoning，系统提示只能压缩不能消除 |
| 上下文上限 | 配置声明 192K；32K 级实测通过，128K 级 10 分钟未返回 |
| 支持 `stream_options.include_usage` | 实测返回真实 prompt/completion token |

---

## 8. 测试策略

| 文件 | 用途 |
|---|---|
| `test/mock-upstream.js` | 假上游（端口 52890），无需装 DuMate 即可验证协议逻辑 |
| `test/smoke.js` | 32 项断言：模型列表、双协议流式/非流式、思维链、token 用量、事件顺序、多轮、工具块、错误路径 |
| `test/verify-ccswitch.js` | 端到端：Codex 路径、Claude 路径、裸路径、模型映射 |
| `probe-oai.js` / `probe-anth.js` | 单路径手动探针，看原始输出 |

设计要点：**断言校验形状而非字面值**。
早期断言写死了 mock 的固定返回（"Hello world"、token 11/7），
接真上游时一批失败——因为真上游返回的是真实文本和真实 token 数。
现在改为"非空"、"大于 0"这类形状断言，mock 和真上游都能过。

还有一个隐蔽陷阱已修复：`message_start` 事件里也有一个全 0 的 `usage` 占位，
正则如果取第一个匹配会误判成 0。现在只取 `message_delta` 上的 usage。

---

## 9. 生命周期脚本

| 脚本 | 作用 |
|---|---|
| `start.bat` | 启动代理（自动拉起后端） |
| `stop.bat` | 停代理 + 停后端 + 校验端口释放；不动 DuMate GUI 和 cc-switch；可重复执行 |
| `restart.bat` | stop → start |

`stop.bat` 用 `taskkill /T`（杀进程树），因为后端是代理的子进程，
杀代理会连带清掉后端。保留后续步骤只为兜底残留进程。

`stop.bat nopause` 参数供 `restart.bat` 内部调用，跳过 `pause` 避免卡住。

---

## 10. 已知限制

1. **cookie 会过期** —— 届时必须开一次 DuMate 客户端重新登录。
2. **不支持工具调用 / 图像** —— 上游无此能力，降级为文本占位。
3. **思考强度不可调** —— 模型没有这个旋钮，只能靠提示词。
4. **超长上下文很慢** —— 128K 级单请求实测超 10 分钟未返回，建议单次控制在 32K 内。
5. **`count_tokens` 是估算** —— 字节数/4，非精确分词。
6. **仅 Windows** —— 依赖 PowerShell / CIM / 注册表路径。
7. **`/v1/models` 是静态列表** —— 不查询上游（上游也无 `/models` 路由，实测 404）。