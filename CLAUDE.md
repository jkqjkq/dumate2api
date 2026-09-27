# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

把百度搭子（DuMate）桌面客户端内部的本地 OpenAI 兼容端点，转成 **OpenAI / Anthropic / Google 三协议网关**，供 Codex CLI、Claude Code、cc-switch 使用。它同时是一个**进程管理器**——负责无 GUI 拉起 DuMate 的 Go 后端。

仓库里跑着**四个互不代理对方的独立进程**（外加一个自建上游）：

| 进程 | 端口 | 入口 | 职责 |
|---|---|---|---|
| DuMate 后端 | 8980 | `upstream-launcher.js` 拉起 | 真实模型链路 |
| **稳定版网关** | 9080 | **`stable/src/server.js`** | **对外提供的稳定服务**，给 cc-switch / Codex 长期用 |
| 开发网关 | 9082 | `src/server.js` | 开发调试（**所有改动在这里做**） |
| 管理端 | 9083 | `src/admin/server.js` | 管理 API（`/api/admin/*`）+ 托管 `web/dist`，读 9082 |
| 多账号网关 | 9084 | `src/web-gateway.js` | 网页凭证跑模型，多账号轮询 |

> **9080 是生产实例，不是本地调试实例**：它对外持续提供服务，改动或重启会直接影响使用者。
> 除非明确要发布新版，否则**不要改 `stable/` 下的代码、不要重启 9080**。
> 所有开发与验证一律在 9082（界面看 9083）进行。
> 发布新版的唯一途径：主目录验证通过后覆盖 `stable/src/` + 更新 `SNAPSHOT_FROM.txt`，再重启 9080。
> 原来另有一个 9081 管理端，与 9083 功能完全重复，已停用——不再需要它。

**三条上游通道，靠模型名前缀分流**（`src/upstream-router.js`）：

| 调用方传的模型名 | 路由到 |
|---|---|
| `glm-5` / `gpt-4o` 等（无前缀） | DuMate 8980，**现有客户端零改动** |
| `qwen/pro` / `qwen/flash` / `qwen/auto` | 千问办公（`src/qwenwork/` 直连 `gateway.qwenwork.cn`） |
| `traework/glm-5.2` | TRAE Work（`src/traework/` 直连，凭证自持） |
| 未知前缀（如 `qwn/pro`） | **400 报错，不静默回落** |

**通道 id 的单一来源是 `src/channels.js`**（`dumate` / `qwenwork` / `traework`）。
`keys.js`（网关鉴权）、`admin/routes/keys.js`（校验）、`usage.js` / `reqlogs.js`
（筛选参数）四处都 require 同一份——加第四条通道只改这一个文件。

**千问与 TRAE 都是直连通道，但彼此也不同**：千问是单账号只读（登录态在客户端
`auth-v2.dat`）、三个积分池；TRAE 是多账号自持凭证、单一 credits + 签到体系。
前端 `isDirectChannel()` 只分「搭子 vs 直连」，页面内部还要用 `isTraework()` /
`isQwenwork()` 再分一次——共用一套模板会把「能不能加账号」「能不能自动续期」
这类问题说反。

**千问办公是进程内直连，不需要任何外部服务。** 早期版本经 Buddy2api（8787）中转，后来发现它的 `wasm_helper.mjs` 本身就是纯 Node ESM 脚本、Python 只是一层没必要的壳，改为直连后少一个进程、少一层鉴权、少一个故障点。`src/qwenwork/` 直接调官方 wasm 生成请求并发到云端网关。

**千问通道的硬约束**：
1. **必须依赖官方 wasm**。千问办公的数据面要求请求体由 `qoder_auth_wasm_bg.wasm` 生成（`Encode=1`），本地自实现的编码会被服务端拒（`400 Invalid agent chat JSON body`）。wasm 文件**不能复制进仓库**——它是客户端二进制资产，必须运行时从安装目录读（`src/qwenwork/wasm-path.js` 自动探测并取版本号最大的目录）。
2. **不套 `mapModel`**。千问的模型名（`pro`/`flash`）不在搭子别名表里，过 `mapModel` 会被兜底成 `model-text`，前缀随之失效。
3. **外层永远 HTTP 200**，真实错误在信封的 `statusCodeValue` 里。**且它不发 `data: [DONE]`**，而是用 `event:finish` 收尾——转发时必须按 OpenAI 规范补发 `[DONE]`，否则 Codex 等客户端认为响应未完成。
4. **请求体必须带 `business` 对象**，否则无论签名是否正确都 `503 Model catalog unavailable`。
5. **`tools` 必须过滤成只留 `function` 形状**。上游只认标准 OpenAI 形状；Codex 每次请求都会带 `namespace`（`multi_agent_v1` / `mcp__cua_repl`）与 `web_search`，**带上任何一个都整轮 400**（不是丢弃那个工具，而是整个请求失败）。过滤在 `src/qwenwork/chat.js` 的 `buildBody`。
6. **`system` 必须留在 `messages` 里**。上游**不读顶层 `system` 字段**——原实现把 system 摘出来单独传，导致系统提示词（含 skills 定义、行为约束）全部丢失，表现为模型「随口答两句就停、不按要求做事」。顶层字段可以照旧带上做兼容，但权威来源是 messages。

**千问的预算与上下文（实测值，别照抄搭子的）**：
- 预算走 `resolveQwenMaxTokens`，下限 **16384**（`DUMATE_QWENWORK_MIN_MAX_TOKENS`）。搭子的 32768 对千问偏大，但 4096 又太小——实测 4096 时 reasoning 会把预算吃光，模型陷入反复推演后只吐一句话。
- 上下文上限 **~1,024,000 token**（1250K 汉字 = 1,022,745 token 通过；1262K 起 502，1300K 起 400）。`pro` 与 `flash` 边界一致。
- **超限不是截断而是整轮失败**（400/502），所以客户端声明的 `model_context_window` 宁可小一点。
- 输出侧 `max_tokens` 约束比搭子松：传 4000 实测能输出 7808，且自然收尾（`stop`）而非被截断。
- 上游只有 `pro` / `flash` 两个模型，没有别的。

**`channel` 字段是必须项**：`reqlog` 每条记录带 `channel`（`dumate` / `qwenwork`）。千问首帧实测 6.7s，与搭子混在同一均值里会让「平均首字延迟」无法归因。

**历史记录（无 `channel` 字段的旧日志）归入搭子**：分通道埋点上线前只有搭子一条通道，单列「未标注」会让用户切到搭子时数字凭空变小。只有「查看全部通道」时才显示 `untagged` 一栏。服务端过滤在 `usage.js` / `reqlogs.js` 的 `channel` 参数里做——前端筛只能筛掉当前页的行，分页总数仍是全通道的。

**千问通道失败不阻断启动**：搭子是主链路。wasm 找不到或登录态缺失时网关照常监听，`/health` 的 `channels.qwenwork.ready` 报 false。

**TRAE Work 的额度要按 `usage_summary` 解析，不是额度包字段。**
`ide_user_ent_usage` 返回的是 `{ usage_summary: { total_amount, consumed_amount } }`，
剩余 = 总额 − 已消耗。早先按 `credits_remain` / `credits_limit` 求和恒得 0，
界面显示「额度 0」被读成「用完了」，而真相是没解析到。
`total_amount` 缺失时返回 `null` 而不是 0。

**TRAE 的签到是 HTTP 200 + body 里的 code**：被限流时返回
`{"code":9074,"message":"当前参与用户太多，请稍后再试"}`。只看状态码会把这次
当成成功，界面显示「签到成功」而额度没变，用户无从察觉——必须读 `code`。

**TRAE 的账与千问、搭子都不同，界面三套分开显示**：搭子靠上游账单 + 余额游标，
千问是三个积分池，TRAE 是每个账号独立的一份 credits（签到领取）。
三边数字**不能相加**。

**每请求 spawn 一次 Node 子进程**（调 wasm_helper.mjs）。若实测成为延迟瓶颈，改成长驻子进程只需改 `src/qwenwork/bridge.js`——`wasm_helper.mjs` 已预留 `serve` 模式，上层 `chat.js` 不受影响。

用前缀而不是猜模型名的理由：两侧模型名会撞车（搭子有 `glm-5`，千问上游也是 GLM 系），猜错了两侧都返回 200，从响应里根本看不出来；且隐式路由会让同一名字今天走 A 明天走 B。未知前缀若静默跑到搭子，会拿到「看起来成功但完全不是想要的结果」，比直接 400 难查得多。


**`stable/` 是冻结快照**——十份网关源码的拷贝，**不随主目录开发改动**，保证 9080 不被开发中的代码波及。要发布新版时把 `src/*.js` 覆盖过去，并把来源提交写进 `stable/SNAPSHOT_FROM.txt`（哈希 + 提交标题 + 日期三行）。快照有自己的启动脚本 `stable/start-stable.bat`，默认用 `<repo>/data`——与开发实例共享同一份数据，这是有意的（账号池共用）。

管理端刻意**不代理模型协议**——网关已经在做，多一跳只会多一个故障点。所有进程通过 `data/` 目录下的文件通信，不通过 IPC。

**三套凭证，互不干扰**：

| 凭证 | 存储 | 特点 |
|---|---|---|
| 桌面凭证 | `%APPDATA%\qianfan-desktop-app\auth.json` | 客户端登录态，**同一时刻只有一份**；cookie 由 Go 后端读，本项目不接触 |
| 网页凭证 | `data/web-accounts.json` | 浏览器 cookie，**明文存**（必须原样重放），可多账号并存 |
| API Key | `data/keys.json` | 我们签发给调用方的，**只存 sha256** |

**关键分界**：桌面端同一时刻只有一个账号可用，网页端可以管多个。所以「两个账号都有效」只在网页端成立——仪表盘的「账号状态」表（桌面）与「账号健康快照」（网页）是两套数据，**不要互相替代**。

**桌面凭证不可用时，搭子会自动回落到网页凭证池**（`src/fallback-web.js`）。
不整体切到网页凭证的原因：桌面链路有三个网页链路没有的能力——`responses`
（Codex CLI 0.155+ 只认它）、`count_tokens`、三通道前缀分流；整体切过去等于
把这些一起丢掉。而桌面凭证唯一的硬伤是「同一时刻只有一份登录态、过期必须开
客户端重登」，那正好是回落能补的。两边是同一个账号，不会造成额度混用。

回落把网页池包装成**伪上游响应**（EventEmitter + statusCode + headers），
四个协议处理器原样复用——**不要为它重写翻译层**，那三套 SSE 状态机是踩了
十几个坑才稳定的。两个易错点：

- **状态码时序**：处理器拿到上游响应会立刻 `res.writeHead(statusCode)`，
  而网页池的状态码要等云端响应头。所以必须「缓冲 → 等 ready → 交出去 → flush」，
  否则失败时头已按 200 发出，客户端收到空的 200（静默失败）。
- **端口解析也在回落范围内**：凭证失效时 `dumate-main-server.exe` 拒绝启动、
  `ensureUpstream()` 抛错——这正是主场景，把端口解析留在调用点就永远走不到回落。

触发条件严格限定为「还没交给回调」：后端连不上（fakeResponse）或回 4xx/5xx。
一旦开始写下游就不再换链路（半截响应 + 换链路会让客户端收到两段拼接的内容）。
埋点带 `credential_source`（仅回落时有值）；`/health` 的
`channels.dumate.fallback` 报回落是否可用——桌面 `ready=false` 而
`fallback.available=true` 时请求仍能成功但走的是网页池，排障时必须知道这点。
`DUMATE_WEB_FALLBACK=0` 可关掉。

**千问没有网页凭证这个概念**：它的「两套」是**先后两代**（旧的只读客户端
`auth-v2.dat` → 现在的自持凭证账号池），不是并行两条链路。所以上面那张表里
「网页凭证」只适用于搭子。

## 命令

```bash
npm start                  # 启动网关（默认 9080，会自动拉起 DuMate 后端）
npm run admin              # 启动管理端（默认 9081）
npm run mock               # 启动假上游（端口 52890），离线自测用
npm test                   # 跑 test/smoke.js（32 项断言），需先起网关
node test/verify-ccswitch.js   # 端到端验证 Codex / Claude / 裸路径 / 模型映射四条链路
node test/probe-oai.js         # 只打 OpenAI 格式的流式探测，直接看原始 SSE
node test/probe-anth.js        # 只打 Anthropic 格式的流式探测（含 x-api-key / anthropic-version 头）
node src/admin/server.js --reset-admin --password=xxxxxx   # 重设管理员口令
node src/web-gateway.js    # 启动多账号网关（默认 9084）
cd web && npm run dev      # 前端开发（Vite 5173，/api 代理到 9081）
cd web && npm run build    # 前端构建（vue-tsc 类型检查 + vite build → web/dist）
```

**`npm test` 只依赖网关**：它直接打 9080，不需要起 mock。先确认 9080 在线（`curl :9080/health`）。

**`npm test` 之外还有两个单点探针**：`test/probe-oai.js` 与 `test/probe-anth.js` 各只打一种协议、把原始 SSE 打到 stdout，用来区分「网关翻译错」还是「上游返回错」——比跑全套 smoke 更快定位。两者都硬编码打 9080。

**开发端口与稳定端口是分开的**：9082/9083 跑主目录代码，9080 跑 `stable/` 快照，互不干扰。开发实例起管理端时**必须带 `DUMATE_ADMIN_GATEWAY_PORT=9082`**，否则管理端会去读 9080（可能没起）而显示空数据——`start-dev.bat` 里设的就是这个变量。

`start.bat` / `stop.bat` / `restart.bat` 是 Windows 生命周期脚本。`stop.bat` 用 `taskkill /T` 杀进程树（后端是网关的子进程），**不动 DuMate GUI 和 cc-switch**，可重复执行；`stop.bat nopause` 供 `restart.bat` 内部调用。

**`.bat` 文件必须保持纯 ASCII——中文提示语会让脚本随机执行乱码片段。**
cmd.exe 按**字节偏移**读取批处理文件；在 `chcp 65001`（UTF-8）下多字节字符
会让偏移失步，某一行从错误位置被读出、尾部被当成命令执行。**且非确定性**：
同一个文件、同一条命令，实测 3 次里 1 次失败 2 次成功。真实损害是
`echo  供 cc-switch / Codex / Claude Code 使用` 的残片 `Code 使用` 被当命令执行，
把 `claude` 当可执行文件启动，**凭空派生出游离的 claude.exe 会话**（表现为
多出几个空终端窗口）。

`chcp` 解决不了：代码页必须在文件被解析之前设好，而 `chcp` 那行本身就是被
解析的文件的一部分。所以规则是**文件内容纯 ASCII**，不是「设对代码页」。
脚本里 `chcp 65001` 仍要保留——它让 **node 子进程**的中文日志正常显示，
与脚本自身文本是两回事。新增脚本请照 `start.bat` / `stop.bat` 的写法。

**改完后端代码必须重启对应的管理端/网关进程。** 后端路由在进程启动时 `require` 一次，不会热更新；而 `web/dist` 是每次请求读磁盘。这个不对称会造成「前端看着是新的、接口返回旧数据」的假象——排查时先看进程启动时间（`netstat -ano | grep ":9083"` 找 pid，再查 `StartTime`），不要先怀疑构建。

重启命令（与 `start-dev.bat` 参数一致）：

```bash
# 9083 开发管理端（日常访问的就是它）
DUMATE_ADMIN_PORT=9083 DUMATE_ADMIN_GATEWAY_PORT=9082 node src/admin/server.js
# 9082 开发网关
DUMATE2API_PORT=9082 node src/server.js
```

纯前端改动才需要 `npm run build`；**纯后端改动不必重新构建**。验证新代码生效的办法：比对 9081 与 9083 同一接口的返回是否一致。

另有两个一键脚本：`start-dev.bat`（同时起开发网关 9082 + 管理端 9083）、`start-web-gateway.bat`（起 9084）。

**`node test/verify-channel.js` 是通道过滤的离线验证**：不依赖任何运行中的服务，直接复用管理端路由与 qwenwork 模块读落盘数据，跑 12 项断言（搭子/千问过滤、历史记录归属、积分 req_id 配对）。改完通道相关代码先跑它。

离线自测的完整流程（无需安装 DuMate）：两个终端分别跑 `npm start` → `npm test`。

## 架构

依赖方向单向、无循环：

```
server.js ──→ discovery.js ──→ upstream-launcher.js
    ├──────→ anthropic.js ──→ budget.js
    ├──────→ google.js ─────→ budget.js
    ├──────→ responses.js ──→ budget.js + anthropic.js(modelmap)
    ├──────→ reqlog.js / modelmap.js / keys.js
    └──────→ admin/*  ← 管理端独立进程复用同一批模块
```

数据流：

```
Codex CLI ── OpenAI/Responses ──┐
Claude Code ── Anthropic ───────┼──→ 网关 :9080 ──→ dumate-main-server :8980 ──→ 百度千帆
任意客户端 ── Google ───────────┘
```

### 网关路由（`src/server.js`）

按 `url`（去 query）精确匹配，未命中返回 404：

| 路径 | 处理方式 |
|---|---|
| `/health` `/ping` | 内联，返回 `{upstream_port, upstream_managed}` |
| `GET /v1/models` | 从 `modelmap.load()` 读 `exposed`，`owned_by` 区分上游真实模型（`dumate`）与别名（`dumate-proxy`） |
| `POST /v1/chat/completions` | **最小干预透传**：只改 `model` 和 `max_tokens`，响应不重打包 |
| `POST /v1/responses` 或 `/responses` | 全量翻译（Responses ↔ Chat），Codex CLI 0.155+ 只认 `wire_api="responses"` |
| `POST /v1/messages` 或 `/messages` 或 `/api/v1/messages` | 全量翻译 Anthropic ↔ OpenAI |
| `POST .../count_tokens` | `字节数/4` 估算，仅供客户端算上下文预算 |
| `GET/POST /v1beta/models/...` | Google Generative Language 翻译 |

**裸路径 `/messages` 必须保留**：Claude Code 打的是不带 `/v1` 的路径，只认带前缀的版本会直接 404。

### 协议翻译层

- `src/anthropic.js` — Anthropic ↔ OpenAI 双向，含 SSE 状态机
- `src/responses.js` — OpenAI Responses API ↔ Chat Completions（Codex CLI）
- `src/google.js` — Google Generative Language ↔ OpenAI
- `src/budget.js` — 输出预算策略，**三个入口共用同一个 `resolveMaxTokens`**

上游不支持 function calling / 图像，工具调用被**降级为纯文本**（`[Tool Use: 名字]`、`[Tool Result]`）——这是能力边界，不是实现缺陷。

## 必须知道的约定与陷阱

**输出预算下限是硬需求，不是可选优化。** GLM 的思维链（`reasoning_content`）和正文**共用同一个 `max_tokens`**，且 reasoning 长度实测在 57~8492 tokens 之间浮动。Claude Code 默认传 150/1024 这类小值，不兜底就会拿到空正文或半句截断（客户端表现为「能快就停」）。`src/budget.js` 把预算钳到 `[DUMATE_MIN_MAX_TOKENS, DUMATE_MAX_MAX_TOKENS]`，默认下限 **65536**（原为 32768，2026-09-26 上调）。

**下限取 65536 的依据是「思维链失控」实测**：Codex 写小说时（一次 3 章 + 完整项目上下文），模型会在 reasoning 里做「全景回顾」——逐条罗列全部素材，停不下来。该轮零工具调用、零正文输出，`output` 恰好撞满上限：
- 预算 32768 → `output=32768 / reasoning=32768 / 正文 0`，耗时 7.5 分钟，整轮空转
- 实测 reasoning 峰值约 28743（占 32768 的 88%）→ 65536 下降到 44%，留出余量

上游搭子自身接受 `[1, 131072]`（传 200000 报 `max_tokens参数非法：限制数值范围[1,131072]`），**32768 从来不是上游限制，是本地默认值**。

**「思维链失控」必须报错而不是 incomplete**（`src/responses.js` 收尾处）。Codex 收到 `status: "incomplete"` 会当成正常收尾（会话日志里 `model_needs_follow_up=false`），前端不提示，用户只看到界面卡回初始态——静默失败，最难排查。现在这种情形发 `response.failed` + `error.code = "reasoning_budget_exhausted"`，客户端会明确报错，埋点也带上 `error` 字段。

**提示词形状会改变是否触发**：若明确要求「落盘到文件」，模型直接调 `exec_command` 写文件，工具调用打断 reasoning，反而不触发；越接近「你想清楚再动手」的指令越容易撞上。

**配置读盘按 mtime 失效，不需要重启网关。** `src/modelmap.js` 和 `src/keys.js` 都落在 `data/` 下，网关与管理端是两个进程，所以两者都在每次调用时比对 mtime 重读。改完模型映射或 API key 立即生效——如果加了启动时读一次的缓存，管理端改完必须重启网关，界面无法解释。

**写盘一律原子。** `store.js` 的 `writeJSON` / `keys.js` 的 `save` / `modelmap.js` 的 `save` 都是先写 `.tmp` 再 `rename`。直接 `writeFileSync` 中途被 kill 会留下半个 JSON，用户表/配置全丢。

**SSE 事件顺序被实测修正过，不要改回去。** Anthropic 规范要求 `message_delta` 在 `content_block_stop` **之后**。早期版本收到 `finish_reason` 就立刻发 `message_delta`，顺序违规。现在只记录 `lastFinishReason`，等流结束统一补发——既修正顺序也保证只发一次。同理 `usage` 只从 `message_delta` 取：`message_start` 里也有一个全 0 的 usage 占位，正则取第一个匹配会误判成 0。

**Responses 路径的 output item 顺序也是硬要求（踩过）。** `reasoning` 与 `function_call` 是并列 item，reasoning 的 `output_item.done` **必须在 function_call 的 `arguments.delta` 之前发出**。原实现只在正文出现时关 reasoning，纯工具调用场景（reasoning 之后直接出工具、没有正文）会把 reasoning 的 done 拖到流末尾——Codex 收到那个 done 后以为 item 已结束，紧接着又收到 `arguments.done`，报 `failed to parse function arguments: trailing characters`，**工具调用直接失败**。修法：开 function_call 前先 `closeReasoningLater()`（`src/responses.js`）。

**流式解析必须用 `StringDecoder`，不能逐块 `toString('utf8')`。** TCP chunk 不按字符边界切，逐块解码会让跨 chunk 的多字节汉字变成 U+FFFD（流式输出里随机出现「�」）。四个解析点都要用：`src/qwenwork/chat.js`（流式 + 非流式）、`src/google.js`、`src/responses.js`、`src/server.js`。

**响应写完后必须停手，否则打挂进程。** `send()` 直接 `res.write()` 时，若 `res.end()` 之后还有收尾逻辑补发事件（如 reasoning 的 done），会触发 `ERR_STREAM_WRITE_AFTER_END`——这是**未捕获的 error 事件，会直接让网关进程退出**（9082 整个挂掉，不是单个请求失败）。修法：`send()` 带 `ended` / `res.writableEnded` / `res.destroyed` 守卫，两处 `res.end()` 都标记 `ended`。

**上游转发只回调一次。** `forwardToUpstream` 用 `settled` 标志 + `once()` 包装；`collectAndFinish` 把 `end`/`aborted`/`error` 三路收拢到同一入口。上游 socket 出错时 Node 会同时触发 error 与后续事件，重复回调会让响应被写两次、客户端永久挂在半开的流上（表现为「输出突然停止」）。

**模型名兜底是唯一可行的容错。** 上游真实模型只有 `model-text` / `model-artifact-validate` / `glm-5`，传别的名字硬性报 `api not registered`。`mapModel` 查不到一律回落 `fallback`（默认 `model-text`），改 `data/model-map.json` 的 `fallback` 会影响全部未知模型名。

**`DUMATE2API_KEY` 是死变量。** 它在 `src/server.js:14` 被赋值，但代码里从未参与任何校验。真正的鉴权开关是 `DUMATE_REQUIRE_KEY=1` + `data/keys.json`。（README 已加说明标注它是历史遗留。）

**`model_allowlist` 只在配了白名单时才读请求体。** 网关鉴权段（`src/server.js:709`）先判断 `key.model_allowlist` 非空才预读 body 取 `model`——否则给默认路径凭空加一次完整读取。结果存 `req._rawBody`，`readBody` 直接复用，**流只能读一次，重复读会拿到空串**。Google 路径的模型名在 URL 里，走正则从路径提取。

**请求埋点失败必须吞掉。** `reqlog.record` 是同步写 JSONL，出错只报一次然后自禁用——埋点绝不能影响正在转发的响应。`logRequest` 用 `res._logged` 去重，因为流式路径会同时挂 `end`/`error`/`aborted` 三个收尾点。

**`req_id` 是埋点与异步采集的唯一关联键。** `logRequest` 生成（或复用 `req._reqId`），写进埋点；千问的积分归因也带同一个值。归因要等 1.5s 结算，`ts` 必然晚于埋点——靠时间戳配对会让同一秒内的两条请求互相串账。`handleDirectChannel` 在进入时就把 `req_id` 定下来并传给 provider，就是这个原因。请求日志按 `indexByReqId()` 把积分明细附到行上。

**千问流式请求在 OpenAI 路径上必须自己补埋点。** 翻译器分支（Anthropic/Responses/Google）各自在 `done` 回调里记，只有 OpenAI 分支没有翻译器——漏了就一条都不记。补埋点时扫 usage 要注意：`provider.send` 回调给的是解信封后的裸 JSON，拼进 `seen` 时必须补上 `data: ` 前缀，否则 `usageFromSSE`（按 `data:` 行扫描）扫不到，token 恒为 0；`first_token_ms` 也要在这里 `markFirstToken`。

**测试断言校验「形状」而非字面值。** 早期断言写死 mock 的固定返回（"Hello world"、token 11/7），接真上游时一批失败。现在只断言「非空」「大于 0」这类形状，mock 和真上游都能过。新增断言请沿用这个原则。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DUMATE2API_PORT` / `DUMATE2API_HOST` | `9080` / `127.0.0.1` | 网关监听 |
| `DUMATE_REQUIRE_KEY` | 未设（关闭） | 设为 `1` 才对模型端点校验 `data/keys.json` |
| `DUMATE_ADMIN_PORT` / `DUMATE_ADMIN_HOST` | `9081` / `127.0.0.1` | 管理端监听 |
| `DUMATE_ADMIN_DATA` | `<repo>/data` | 覆盖数据目录（管理端与网关必须一致） |
| `DUMATE_MIN_MAX_TOKENS` / `DUMATE_MAX_MAX_TOKENS` | `65536` / `131072` | 输出预算钳制区间（`0` 关闭下限策略） |
| `DUMATE_AUTOSTART` | `auto` | `auto`=无实例才拉起 / `always`=总是自己拉起 / `off`=只用已有实例 |
| `DUMATE_UPSTREAM_PORT` | `8980` | 自建后端端口 |
| `DUMATE_INSTALL_DIR` | DuMate 默认安装路径 | 安装目录不在默认位置时设置 |
| `DUMATE_UPSTREAM_TIMEOUT_MS` | `600000` | 上游请求超时 |
| `DUMATE_UPSTREAM_LOG` / `DUMATE_DEBUG` | - | 设为 `1` 输出后端日志 / 发现过程调试信息 |
| `DUMATE_ADMIN_GATEWAY_PORT` | `9080` | **管理端去读哪个网关的状态**；开发实例应设为 `9082`，否则会显示稳定版的数字 |
| `DUMATE_WEB_GATEWAY_PORT` / `_HOST` | `9084` / `127.0.0.1` | 多账号网关（网页凭证）监听 |
| `DUMATE_TASK_POLL_MINUTES` | `30` | 任务自动轮询间隔（`0` 关闭）；**低于 5 分钟会被拒绝**——过密轮询无收益只有封号风险 |
| `DUMATE_AUTO_CHECKIN_HOUR` / `_MINUTE` | `9` / `17` | 每日自动签到时刻 |
| `DUMATE_BROWSER_PATH` | 自动探测 Edge/Chrome | 登录器找不到浏览器时手动指定 |
| `DUMATE_QWENWORK_AUTOSTART` | `auto` | `auto`=启用千问通道 / `off`=关闭（进程内直连，不拉起外部服务） |
| `DUMATE_QWENWORK_INSTALL` | 自动探测 | 千问办公安装根（wasm 探测失败时手动指定） |
| `CB_QWENWORK_WASM` | 自动探测 | 直接指定 `qoder_auth_wasm_bg.wasm` 的完整路径 |
| `DUMATE_QWENWORK_DAILY_CREDITS` | `100` | 千问每日免费额度的**配置兜底下限**（接口不返回上限，只作推断的下界） |
| `DUMATE_QWENWORK_MIN_MAX_TOKENS` | `16384` | 千问输出预算下限（与搭子的 `DUMATE_MIN_MAX_TOKENS` 分开） |
| `DUMATE_QWENWORK_CREDIT_CACHE_MS` | `30000` | 千问余额缓存时长，避免每次请求都打站点接口 |
| `DUMATE_ADMIN_SECURE_COOKIE` | 未设（不置 Secure） | 设 `1` 才给会话 cookie 加 Secure（本地 http 下会被浏览器丢弃） |

## 数据文件（`data/`，已 gitignore）

| 文件 | 内容 |
|---|---|
| `keys.json` | API key，**只存 sha256**，明文仅在创建时返回一次 |
| `model-map.json` | `aliases` / `upstream_models` / `exposed` / `fallback` |
| `admin-users.json` | 管理员口令（scrypt，N=2^18）与 `session_version` |
| `admin.secret` | 会话签名密钥，与用户表分开存 |
| `admin-audit.jsonl` | 管理操作审计 |
| `requests.jsonl` | 网关埋点，超 32MB 轮转一次留 `.1` |
| `web-accounts.json` | 网页账号，**cookie 明文存**（上游要求原样重放，与 keys 的只存哈希是两种策略） |
| `activity.jsonl` | 统一操作记录（签到/任务/抽奖），按时间排序 |
| `task-runs.jsonl` / `task-scheduler.json` | 任务执行历史 / 轮询配置 |
| `auto-checkin.json` | 自动签到配置 |
| `qwenwork-credits.jsonl` | 千问积分归因（每请求一条，带 `req_id` 与请求日志配对） |
| `qwenwork-daypeak.json` | 千问每日额度的观测峰值，用于推断「每日上限」 |

**两个 `data/` 目录的陷阱**：`DUMATE_ADMIN_DATA` 决定数据目录，管理端与网关必须一致，否则读到的账号/埋点不同。`stable/` 快照若也跑起来，默认用 `<repo>/data`——与开发实例共享同一份数据，这是有意的（账号池共用）。

**但 9080 当前实际跑的是 `stable/data/`，不是 `<repo>/data`**（实测 2026-09-26）。`reqlog.js` 的 `ROOT = path.resolve(__dirname, '..')`——stable 副本的 `__dirname` 是 `stable/src`，所以未设 `DUMATE_ADMIN_DATA` 时落 `stable/data`。而 `start-stable.bat` 里写着 `set DUMATE_ADMIN_DATA=%~dp0..\data`，说明**现在这个 9080 不是用它自己的脚本起的**（手工起的，没有该环境变量）。后果：9083 管理端读 `<repo>/data`，看不到 9080 的流量——排查时若拿管理端数据核对 9080，会得出「请求根本没经过网关」这种错误结论。查 9080 的埋点必须直接看 `stable/data/requests.jsonl`。

`keys.js` 的 CIDR 匹配是 **fail-closed**：非法条目返回 false（写错一条 CIDR 会让这把 key 对所有来源拒绝，而非意外放行）。token 比对逐条走 `timingSafeEqual`，避免通过响应耗时逐字节猜 token。

## 平台与依赖

- **仅 Windows**：依赖 PowerShell / CIM 查询进程命令行与监听端口、`%APPDATA%\qianfan-desktop-app\auth.json`、`taskkill`。
- **网关本身零第三方依赖**（`stable/` 快照更是如此），只用 Node 内置 `http`/`net`/`child_process`/`fs`/`crypto`。Node >= 18。
- **根 `package.json` 有 `playwright-core`**，但只被管理端的浏览器登录器 `src/login-browser.js` 用到——用来打开受控窗口抓 cookie（系统浏览器 cookies 库运行时被独占锁，读不到）。复用系统已装的 Edge/Chrome，不下载 Chromium。
- **前端有依赖**（Vue 3 + ant-design-vue + Tailwind + ECharts），在 `web/` 下单独 `npm install`。

## 管理端模块（`src/` 下除网关外的部分）

| 模块 | 职责 |
|---|---|
| `dumate-web.js` | 网页端 API 封装（签到 / 任务 / 抽奖 / 积分） |
| `accounts.js` | 网页账号存储，cookie **明文存**（必须原样重放） |
| `web-pool.js` | 网页凭证账号池，轮询 + 故障转移 |
| `web-gateway.js` | 9084 独立网关，用网页凭证跑模型 |
| `task-runner.js` / `task-scheduler.js` | 任务自动跑 + 后台轮询 |
| `records.js` | 统一操作记录（签到/任务/抽奖） |
| `points-agg.js` | 额度包聚合（按来源 / 按发放日 / 临期 / 已过期未用完）。本地后端与网页账号拿到的是同一份额度包结构但字段来源不同，两份都要得出同样的派生视图——收敛在这里，否则「一边按到期日、一边按发放日判断还在不在发」这种口径漂移必然发生 |
| `points-cursor.js` | 单请求积分成本（余额游标差）。上游账单无法归因到具体请求（同一时间窗有 1~3 条候选扣费，硬挑一条等于编数字），改用「每条请求结束后记一次余额、相邻两次差值即后一条的成本」。**每账号一条串行队列**——丢一条游标会让下一条的差值跨过两条请求，静默算错，所以宁可排队也不缺档 |
| `login-browser.js` | 浏览器登录器（唯一依赖 playwright-core 的地方） |
| `admin/routes/traework.js` | TRAE Work 通道的管理接口：`/status` 通道健康+账号列表（mode=multi，可增删）、`/models` 模型表（只读）、`/credits` 各账号额度与签到状态、`/checkin` 手动签到（幂等）、**`/login/url` + `/login/callback` 两步 OAuth 登录**、`DELETE/PATCH /accounts/:id` |
| `admin/routes/qwenwork.js` | 千问办公通道的管理接口：`/status` 通道健康、`/credits` 三个池、`/credits/daily` 按天聚合、`/credits/records` 逐笔明细、`/models` 模型表、**`/account` 登录态详情（只读）**、**`/accounts` 账号（`mode='single'` 表示单账号直连，不可增删）** |
| `admin/routes/*.js` | 管理 API，按 `mount()` 挂载到 `/api/admin/<前缀>` |

**千问登录态只读，管理端绝不写入。** 它存在官方客户端的 `auth-v2.dat` 里（Electron safeStorage：DPAPI 解 `Local State` 的 `encrypted_key` → 32B AES key → AES-256-GCM 解密）。官方客户端和我们各写一次会互相把对方的登录态刷掉，所以换账号必须开客户端操作。**不复制这个文件到 `data/`**——它会过期，复制一份立刻失效。`refresh_token` 过期（`refreshExpired`）要提前告警：access token 到期后无法自动续期。

**API Key 可选绑定通道**（`keys.js` 的 `channel` 字段，`''` = 不限）。网关鉴权段用 `upstream-router.resolve(model).channel` 解析请求走哪条通道再传给 `validate()`——设了 `qwenwork` 的 key 调搭子模型会被 403 `channel_not_allowed`。注意鉴权段**只在 key 真的配了模型白名单或通道绑定时才预读请求体**，否则给默认路径凭空加一次完整读取。key 用量按通道分开统计（`usage.channels`），因为网关按模型名前缀分流、不按 key 分流，同一把 key 可能两条通道都在用。

**两套「用量」视图不要互相替代**：`stats.js` 与 `usage.js` 都读 `data/requests.jsonl`，但 `usage.js` 还额外查上游计费记录——本地只知道「发了多少 token」，不知道「扣了多少积分」，计费规则在上游。`reqlogs.js` 则是逐条明细与单条详情（聚合看趋势、明细查个案）。

**`chatlab.js` 刻意绕过密钥与 IP 管控**：它只要求管理员会话，走的是与 9084 同一套账号池、消耗真实积分。定位是「在管理端里验证某个模型名能不能跑通」，不必先去签发密钥。与 9084 的分工是：9084 面向外部客户端、带鉴权、做协议兼容；chatlab 是内部试调、返回便于展示的结构化数据（含每条回答的实测消耗）、不做协议翻译。

**`autotask.js` 只给签到做定时，抽奖只留手动**：签到幂等（当天已签就跳过），多跑无害；抽奖消耗次数且不可逆。定时配置落盘到 `data/auto-checkin.json`——定时器只活在进程内，重启后得知道上次开没开、几点跑。

**路由匹配是锚定整串的**（`router.js` 的 `anchor()`），所以 `/models/map` 不会误吞 `/models/map/reset`。注册时 `path: ''`（如账号列表）会与前缀拼成 `/api/admin/web-accounts`，`mount` 里做了去尾斜杠处理。

## 前端（`web/`）

Vue 3 + Vite + ant-design-vue 4 + Tailwind + ECharts（按需引入，不用全量，省约 1MB 首屏）。开发时 Vite 把 `/api` 代理到 9081（`vite.config.ts`），**改的是哪个管理端端口就要对应改这里**——代理写死 9081，跑开发实例 9083 时前端页面会拿到 9081 的数据。

**设计方向是深色控制台，不是浅色后台。** 这套系统的本体是「模型网关的控制室」：请求量、账号池、上游健康、积分流水，信息密度高、看数时间长。三层共享设施各管一段，**改一处全站生效**：

| 位置 | 管什么 | 为什么必须在这一层 |
|---|---|---|
| `App.vue` 的 `ConfigProvider` | AntD `darkAlgorithm` + token | Select 下拉、Modal、DatePicker、Message 这些浮层不在卡片内，scoped 样式够不到，只有 token 能一次改干净 |
| `src/style.css` 的 `--lab-*` | 分层底色、青色信号色、卡片/表格/按钮基线 | 各页面各写一遍圆角阴影必然漂移 |
| `tailwind.config.js` | **把 `slate` 槽位整体重映射为控制台灰阶** | 全站 100+ 处 `text-slate-400` 这类工具类因此一次性换到深色语义。**新增页面继续用 `slate-*`，不要为了「准确」改成语义色名**——那样等于把这层映射废掉，回到逐页维护 |
| `src/utils/chartTheme.ts` | 图表色板与轴样式 | 分类色按固定槽位取用、不按排名重排（否则筛掉一条序列会让其余序列换色，读者刚建立的对应关系就废了） |

**通道切换是全局状态，不是各页各存一份。** `web/src/stores/channel.ts` 管「当前在看哪个通道」，持久化到 localStorage，顶栏切（不是侧栏——侧栏可折叠，折叠后切换器会消失，而通道是任何时候都不该丢的上下文）。`CHANNELS` 里的 `menuKeys` 是该通道**有意义**的菜单白名单：千问没有「任务记录」（无签到/抽奖），账号管理只做只读展示。

**各页面必须 `watch` 通道变化并重新拉数据**，不能只在 `onMounted` 读一次——否则顶栏切了、页面还是旧通道的内容。两个数据源结构不同的页面（登录态、积分明细、账号管理、模型管理、API Key）用 `v-if="isQw"` / `<template v-else>` 分开两套模板，共用同一个路由；只差筛选条件的页面（用量统计、请求日志、聊天测试台）同一套模板，只换请求参数。

**千问办公的账与搭子完全不同，界面必须分开显示**：搭子靠上游账单 + 余额游标（`points-cursor.js`），千问是三个积分池（`daily` 免费 / `monthly` 订阅 / `longterm` 充值）按 `req_id` 归因。两边数字**不能相加**。千问的「每日上限」接口不返回，由「观测峰值 + 配置兜底」推断（`credits.js` 的 `dailyUsageFromBalance`），界面要标出 `limitSource` 是 `observed` 还是 `config-lower-bound`。

**新页面的骨架约定**：

- 外层用 `.page`，页头用 `PageHeader.vue`。`.page` 用 `gap` 统管间距并清掉直接子元素自带的 `mt/mb`——否则「gap + margin」会叠成双倍间距，且各页面各不相同。
- 所有数值加 `.num`（或 `mono`）类：等宽 + `tabular-nums`。比例字体下数字宽度不一，逐行累加会让整列看起来在抖。
- 状态色用 AntD 的语义名（`color="green" | "red" | "orange"`），不写十六进制。深色下这些色值已在 `tailwind.config.js` 里提亮（默认的 `#52c41a` 压不住近黑底）。
- 载入动效是 `.page > *` 的错峰浮起，一次编排好过满屏微动效；已用 `prefers-reduced-motion` 兜住。

## 排查 Codex / 客户端侧问题

**先分清「网关错」还是「客户端侧错」**，否则会改错地方：

1. **看 Codex 的会话日志**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。每条都是完整交互记录（含 system 提示词、工具调用、上游返回）。用第一行的 `payload.cwd` 认出是哪次会话。
2. **看网关埋点**：`data/requests.jsonl` 有 `channel` / `model` / `mapped_model` / `input_tokens` / `output_tokens`。`mapped_model` 能立刻看出前缀有没有生效（`qwen/flash` 应映射成 `flash`，若变成 `model-text` 说明路由错了）。
3. **看进程存活**：网关崩溃（如 `ERR_STREAM_WRITE_AFTER_END`）会让端口直接消失，表现为客户端「连接被拒」而不是报错。

**Codex 的本地工具走 PowerShell（`pwsh.exe`），不是 bash。** 排查 Codex 工具行为（读文件乱码、命令语法、路径）要按 PowerShell 语义判断。一个真实坑：项目里的 `.md` 是**无 BOM 的 UTF-8**，中文 Windows 上 PowerShell 的 `Get-Content` 默认按 GBK 解码，会把中文读成乱码（`世界观` → `涓栫晫瑙?`），让 Codex 基于垃圾输入工作、反复纠结编码。这是客户端/环境侧的事，网关改不了。

**HTTP 402 是额度问题，不是代码问题。** 千问额度耗尽时所有请求（含最简单的 `hi`）都返回 402。判断方法：拿一个极小请求做对照——若它也 402，就是额度；若小请求成功而大请求失败，才是上下文/格式问题。查余额：`require('./src/qwenwork/credits').fetchWallets({force:true})`。

**`is_reasoning` 是硬编码的 `false`**（`src/qwenwork/chat.js`），`reasoning_effort` 也不透传给上游。实测搭子对 `reasoning_effort` 不敏感（none/low/medium/high/xhigh 的 reasoning token 数不单调：922/503/434/426/829，属噪声）。**想提升推理深度只能靠提示词，调参数无效。**

## 无 GUI 运行的前提

`src/upstream-launcher.js` 是整个项目唯一的逆向成果：`dumate-main-server.exe` 平时由 Electron 通过 IPC 注入登录态，单独启动会报 `loginMode is required`；逆向发现它支持从 `DUMATE_LOGIN_MODE=standalone` 等 4 个环境变量读登录上下文，账户信息从 `auth.json` 的 `activeProfileId` 取。

**cookie 本身不由本项目处理**——它仍留在 `auth.json` 里由 Go 后端自己读，本项目不接触也不复制凭证。因此 **cookie 过期后必须打开一次 DuMate 客户端重新登录**，这个绕不过去。

更细的逆向结论与实测数据见 [ARCHITECTURE.md](ARCHITECTURE.md)（含端口发现三级降级、预算实测表、SSE 状态机细节）。
