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
> 发布新版的唯一途径：主目录验证通过后按**依赖闭包**同步 `stable/src/` + 更新 `SNAPSHOT_FROM.txt`（不要用 `src/*.js` 覆盖——会漏掉子目录、多带管理端，详见下文「`stable/` 是冻结快照」）。
> 原来另有一个 9081 管理端，与 9083 功能完全重复，已停用——不再需要它。

> **9080 不一定在运行**：它是按需启动的对外服务，不是常驻开发环境。动手前先 `netstat -ano | grep ":9080"` 确认。若它没在跑而你被要求「发布新版」，正确做法是**只同步快照文件**，不要顺手把它启动起来——启动一个对外服务是用户的决定，不是发布流程的一部分。

**四条上游通道，靠模型名前缀分流**（`src/upstream-router.js`）：

| 调用方传的模型名 | 路由到 |
|---|---|
| `glm-5` / `gpt-4o` 等（无前缀） | DuMate 8980，**现有客户端零改动** |
| `qwen/pro` / `qwen/flash` / `qwen/auto` | 千问办公（`src/qwenwork/` 直连 `gateway.qwenwork.cn`） |
| `traework/glm-5.2` | TRAE Work（`src/traework/` 直连，凭证自持） |
| `qoder/gfmodel` | Qoder（`src/qoder/` 直连，**签名纯本地、不需要客户端**） |
| 未知前缀（如 `qwn/pro`） | **400 报错，不静默回落** |

**通道 id 的单一来源是 `src/channels.js`**（`dumate` / `qwenwork` / `traework` / `qoder`）。
`keys.js`（网关鉴权）、`admin/routes/keys.js`（校验）、`usage.js` / `reqlogs.js`
（筛选参数）四处都 require 同一份——加一条通道只改这一个文件。

**千问与 TRAE 都是直连通道，但彼此也不同**：千问是单账号只读（登录态在客户端
`auth-v2.dat`）、三个积分池；TRAE 是多账号自持凭证、单一 credits + 签到体系。
前端 `isDirectChannel()` 只分「搭子 vs 直连」，页面内部还要用 `isTraework()` /
`isQwenwork()` 再分一次——共用一套模板会把「能不能加账号」「能不能自动续期」
这类问题说反。

**Qoder 是第四条通道**（2026-10-02 接入，`src/qoder/`）：阿里 AI IDE，
与千问办公**同一套 COSY 协议**（同样的 `Encode=1` 自定义 base64、同样的
`Bearer COSY.<payload>.<sig>` 信封、同样的 device flow 登录，**连 client_id 都相同**）。
但有两点关键差异：

1. **签名不需要官方 wasm**——纯本地算法（RSA 加密临时密钥 + AES 加密身份 + MD5 签名，
   公钥硬编码，见 `src/qoder/cosy.js`）。所以这条通道**不需要装任何客户端**
   （`/health` 的 `needsClient: false`）。千问必须读客户端的 wasm，Qoder 不用。
2. **额度分两块且不能相加**：`userQuota`（订阅套餐内，Free 恒为 0）与
   `addOnQuota`（签到/赠送，**免费用户实际能用的就是这个**）。

**零额度时聊天会挂起**（不报错、不超时失败），所以**签到是通道可用的前提**——
新账号必须先 `checkin` 领积分。签到链路 `GET /sash/api/v1/me/campaigns` →
`POST .../{id}/claim`，**不需要签名**，只要 device token + `cosy-clienttype: 10`。

**积分过期要本地记账，因为上游没有逐批余额接口**（`src/qoder/grants.js`）。
实测 `/api/v2/quota/detail`、`/sash/.../grants`、`/sash/.../credit-packs` 等一律
503/404——**唯一带到期信息的是领取响应本身**（`benefit.validity` = `RELATIVE_DAYS`/30 天
+ `grantedAt`）。所以每次签到往 `data/qoder-grants.jsonl` 落一条（幂等键 `grantId`），
过期提醒才有数据源。**活动列表对已领活动不返回领取时间**，所以无法回填——
账本从功能启用时开始记，界面要如实标出覆盖范围（`/grants` 的 `since` 字段），
否则「账本里没有」会被读成「没有积分」。

**「领取额」不是「剩余额」**——这是本通道的数据缺口，必须如实标注。上游只告诉
我们这批领了多少，不告诉我们还剩多少。千问（每包有独立余额）与 TRAE（每包有
`remain`）都没有这个问题，**不要照搬它们的措辞**。界面一律写「领取额」，
并注明「实际剩余以额度卡总余额为准」。

**签到积分领取后 30 天作废，每日 10:00 (UTC+8) 刷新**——注意**不是 00:00**
（千问是 00:00 重置，两者不同）。`/qoder/grants` 与仪表盘的过期明细按此展示。

**模型选择要同时设 body 与请求头**：body 的 `model_config.key` / `chat_context.extra.modelConfig.key`
**加**请求头 `x-model-key` / `x-model-source`（只设 body 时上游仍走 `auto`）。
而且**响应里的 `model` 字段恒为 `"auto"`**（上游如此），不能据此判断实际模型——
真正的判据是 `system_fingerprint`（实测 `dmodel` → `a307abda…`、`kmodel_latest` → `fpv0_3f6baf1…`）。

**倍率差 14 倍，开发调试一律用 0.1 档**：`qfmodel`/`qmodel`/`q37fmodel`/`dfmodel`/`gfmodel`。
实测 5 个 0.1 档请求合计不到 0.01 credits，而 `kmodel_latest`(Kimi-K3) 是 1.4 档。
倍率从模型表接口的 `price_factor` 读，**不硬编码**。

**Qoder 的 usage 直接返回 credits 消耗**（三条直连通道里唯一如此）：
`usage.credits = price_factor × tokens/1000`，比千问（读余额差）和 TRAE（读 usage_summary）都干净。

**`cosy.encode` 是同步的，它一慢就「假死」整个网关（2026-10-03 修，性能级）。**
自定义 base64 编码在 `runOnce` 里**直接同步调用**，所以它的耗时会**阻塞事件循环**：
期间 `/health` 不响应、其他通道的请求全部排队、进程 CPU 跑满却**不崩也不打日志**。
客户端表现是「一直转圈、没有任何输出」（cc-switch 侧报
`504 流式响应首包超时: 600s`，两次重试 ≈ 23 分钟，与用户看到的一致）。

原实现是 `let out=''; for(...) out += mapped;`——V8 的字符串拼接近似 **O(n²)**，
再叠上 `std.slice()` 三段重排的临时字符串。实测：

| 输入 | 原实现 | 现实现 |
|---|---|---|
| 16 MB | 3.1 s | 0.26 s |
| 64 MB | **15.2 s** | 1.05 s |
| 128 MB | **4 GB heap OOM 崩溃** | 1.77 s |

改法是**下标置换 + 预计算查表（Uint8Array 按码点直索引）+ 一次性 Buffer**，
全程 O(n)、无中间大字符串——重排本质是纯下标置换（新串第 i 位 = 原串第 perm(i) 位），
不必真的拼字符串。正确性由 `test/verify-qoder-encode-perf.js` 与朴素实现
**穷举比对**（2200+ 组，含 len 0-400 × 5 种填充 + 随机字节）+ 固定向量锁定。

**同类风险**：翻译层也有 `fullText += delta.content` 这类累积，但它们累积的是
**模型输出**（KB 级），而 `encode` 处理的是**整个请求体**（Codex 一次能发几十 MB），
量级差三个数量级——**不要把两者混为一谈，后者才是真瓶颈**。

**排查这类「静默假死」的办法**：`node -e "process._debugProcess(<pid>)"` 打开
inspector，再用 WebSocket 连 `:9229` 发 `Debugger.pause` 抓调用栈。
**注意**：若阻塞发生在**原生代码**里（如 RSA/AES 或 GC），`pause` 会超时无响应——
那本身就是「阻塞在 native」的信号。本次正是靠它抓到 `encode @ cosy.js`。

**网关现在带事件循环卡顿监控**（`startLagMonitor`，`src/server.js`）：卡顿超过
`DUMATE_LAG_WARN_MS`（默认 2000ms）就打一条带时长的日志。它不解决卡顿，
但把「静默假死」变成「日志里有明确时间点」。`DUMATE_LAG_MONITOR=0` 关闭。

**跨进程陷阱**：`model-info.js` 的 `qoderRows` **必须自己拉模型表**（`session.fetchModels`），
不能只读 `setQoderModels` 写的快照——快照由网关进程写入，而 `/models/info` 跑在管理端进程，
两者模块状态独立。TRAE 同理（`traeworkRows` 直接 `fetchModels`）。

**千问办公是进程内直连，不需要任何外部服务。** 早期版本经 Buddy2api（8787）中转，后来发现它的 `wasm_helper.mjs` 本身就是纯 Node ESM 脚本、Python 只是一层没必要的壳，改为直连后少一个进程、少一层鉴权、少一个故障点。`src/qwenwork/` 直接调官方 wasm 生成请求并发到云端网关。

**千问通道的硬约束**：
1. **必须依赖官方 wasm**。千问办公的数据面要求请求体由 `qoder_auth_wasm_bg.wasm` 生成（`Encode=1`），本地自实现的编码会被服务端拒（`400 Invalid agent chat JSON body`）。wasm 文件**不能复制进仓库**——它是客户端二进制资产，必须运行时从安装目录读（`src/qwenwork/wasm-path.js` 自动探测并取版本号最大的目录）。
2. **不套 `mapModel`**。千问的模型名（`pro`/`flash`）不在搭子别名表里，过 `mapModel` 会被兜底成 `model-text`，前缀随之失效。
3. **外层永远 HTTP 200**，真实错误在信封的 `statusCodeValue` 里。**且它不发 `data: [DONE]`**，而是用 `event:finish` 收尾——转发时必须按 OpenAI 规范补发 `[DONE]`，否则 Codex 等客户端认为响应未完成。
4. **请求体必须带 `business` 对象**，否则无论签名是否正确都 `503 Model catalog unavailable`。
5. **`tools` 必须过滤成只留 `function` 形状**。上游只认标准 OpenAI 形状；Codex 每次请求都会带 `namespace`（`multi_agent_v1` / `mcp__cua_repl`）与 `web_search`，**带上任何一个都整轮 400**（不是丢弃那个工具，而是整个请求失败）。过滤在 `src/qwenwork/chat.js` 的 `buildBody`。
6. **`system` 必须留在 `messages` 里**。上游**不读顶层 `system` 字段**——原实现把 system 摘出来单独传，导致系统提示词（含 skills 定义、行为约束）全部丢失，表现为模型「随口答两句就停、不按要求做事」。顶层字段可以照旧带上做兼容，但权威来源是 messages。

**千问的预算与上下文（实测值，别照抄搭子的）**：
- 预算走 `resolveQwenMaxTokens`，下限 **16384**（`DUMATE_QWENWORK_MIN_MAX_TOKENS`），**默认值 131072**（`DUMATE_QWENWORK_DEFAULT_MAX_TOKENS`，与搭子的 `DEFAULT_BUDGET=32768` 分开）。搭子的 32768 对千问偏大，但 4096 又太小——实测 4096 时 reasoning 会把预算吃光，模型陷入反复推演后只吐一句话。
- **上游接受的 `max_tokens` 范围是 `[1, 131072]`**（实测 2026-09-27）：131072 通过，**131073 起一律 400**（`pro` / `flash` 边界一致）。**省略该字段不报错**，实测一次输出到 66807 token 才自然收尾（`finish=stop`）——说明上游自己的默认值远大于 66807。
- 因此默认值直接取上游上限 131072：原来网关发 32768，**是网关自己把上限压低了**。代价实测过——Codex 不发 `max_output_tokens`，网关按默认值下发，实测「一次写 3 章」的单轮输出（≈8400 字正文 + 工具参数里又写一遍正文 + 两万多 token 推理）正好撞满 32768，上游报 `length`，断在工具参数中间那一章就丢了（实测断在 `@('第三章　第七户','',`）。取上限后网关不再是那个约束，与官方客户端行为一致（客户端自己也不带这个字段）。
- 上下文上限 **~1,024,000 token**（1250K 汉字 = 1,022,745 token 通过；1262K 起 502，1300K 起 400）。`pro` 与 `flash` 边界一致。
- **超限不是截断而是整轮失败**（400/502），所以客户端声明的 `model_context_window` 宁可小一点。
- 输出侧 `max_tokens` 约束比搭子松：传 4000 实测能输出 7808，且自然收尾（`stop`）而非被截断。
- 上游只有 `pro` / `flash` 两个模型，没有别的。

**千问通道必须给带工具的请求注入「执行纪律」**（`src/qwenwork/chat.js` 的 `withAgentDiscipline`）。
千问上游是**对话型**产品，其脚手架鼓励「每完成一步汇报一句」；Codex 的 `AGENTS.md` 里也有同样的进度播报要求。两者叠加后模型会把播报当成一次完整回合：只输出 `进度：N/8｜下一步：写第 N 章` 就结束，**不调用任何工具**——Codex 收到「无工具调用」的回合即判定任务完成并退出，用户看到的就是「没按要求做完就退出」。实测（2026-09-27，真实 Codex 会话 `01a0e205`，一次写 3 章小说）：

- 不加纪律：连续多轮都只播报进度就收尾（把第 4 章之后的任务全丢下）；重放同一上下文 10 次有 2 次触发
- 加了纪律：**同一会话同一指令**，模型连续调用工具写完第 5、6、7 章才收尾（对比：该会话此前每轮只调 1 次工具）

只对「最终确实带工具」的请求注入（工具全被过滤掉的纯对话注入会干扰正常回答），且幂等。`DUMATE_QWENWORK_AGENT_DISCIPLINE=0` 关闭。离线验证：`node test/verify-qwen-discipline.js`。

**第二类诱因是「项目自带的技能」**（2026-09-27 补，会话 `01a0e346` 实测）。
sanguo 项目的 `novel-creator` 技能把写作拆成分阶段门控（「起草前先声明本章目标/POV/节拍」→「写完更新连续性台账」→「每章过连续性检查」，还写着「让用户审定基调后才继续」）。模型会在第一个门控处就停下播报，于是 `继续创作下3章内容` 变成「盘点项目 → 读 3 章 → 播报 20% → 结束」，0 章落盘。

**根因不是纪律、也不是 agent 侧——是 `flash` 档位**（2026-09-28 对照实测，同一会话 `01a0e346`、同一指令「继续一次3章写完ai审查」、同一份 AGENTS.md 与技能）：

| 上游 | 上游请求数 | 工具调用 | 写文件 | 产出 | 耗时 | reasoning 合计 |
|---|---|---|---|---|---|---|
| **搭子 `glm-5`**（8980） | 24 | 23 | 7 | **090-092 三章 + AI 审查 + 报告 + 台账** | **317s** | **172** |
| **workBuddy `global:hy4-preview-f`**（7864） | 20 | 19 | 5 | **084-086 三章 + AI 审查 + 报告 + 台账** | 997s | — |
| 千问 `qwen/pro`（9082） | 28 | 27 | 5 | **087-089 三章 + AI 审查 + 报告 + 台账** | 361s | 743 |
| 千问 `qwen/flash` 原始纪律 | 3 | 2 | 0 | **0 章**，停在核对 | 78s | 2000-6400/轮 |
| 千问 `qwen/flash` 加强纪律（技能流程+交付纪律） | 2 | 1 | 0 | 0 章 | 55s | 2000+/轮 |
| 千问 `qwen/flash` 无条件纪律（任何无工具回复都算失败） | 3 | 2 | 0 | 0 章 | 66s | 2000+/轮 |

**三个上游（搭子 glm-5 / workBuddy 前沿档 / 千问 pro）都完整跑通，只有 `flash` 三种纪律写法全失败**——所以这不是提示词能修的，是档位能力差异。`flash` 的失败形态很一致：推理很长（单轮 reasoning 2000~6400 token），只做「核对/确认」这类准备动作，然后把结论（「086 有一处道具冲突要先修」「核对 085/086 与貂蝉化名」）当作回合终点输出，**推理里写了「让我读 086 原文再精准改」却不发那个工具调用**。对照：搭子 glm-5 整轮 reasoning 只有 172 token、`pro` 743 token，预算全用在工具调用上。

**结论：千问通道做重创作/长任务用 `pro`，不要用 `flash`**（`flash` 只适合轻量问答）。搭子是这批里最快也最省的（317s / 172 reasoning），适合作为长任务首选。这条与「纪律注入」无关，纪律本身仍然保留（它解决的是另一类「播报即收尾」，在 `01a0e205` 会话实测有效）。

判定这类问题时要**分清「网关行为」与「模型行为」**：把出问题的那次请求（从会话日志重建 input + instructions）经网关重放，如果稳定调工具（本次 5/5、多轮循环 6 轮 × 3 次全正常），说明是概率性的模型行为而不是网关丢帧——**不要为了一个复现不出来的现象去改翻译层**。本次排查还顺带确认：sanguo 会话上下文其实只有 1.3~2.5 万 token（网关日志里 25 万那条属于另一个会话），所以与长上下文无关。

**工具参数被截断必须报 `incomplete`，不能报 `completed`**（`src/responses.js` 的 `truncatedArguments`）。
上游在 `finish_reason=length` 处会把 `arguments` 停在半句 JSON（实测 `{"cmd": "... @('第三章　第七户','',`，字符串都没闭合）。网关若当正常工具调用交给 Codex，Codex 会**执行一条语法残缺的命令**：命令必然失败，模型看到失败后往往只回一句「下一步：写入第 N 章」就结束回合。现在这种参数会被判成 incomplete，埋点带 `error=tool_arguments_truncated`。离线验证：`node test/verify-truncated-toolcall.js`。
顺带修掉一个误报：`emptyButTruncated` 原来只排除 `stop`，把**纯工具调用轮次**（`finish_reason=tool_calls` + 正文 0，Codex 里大量存在）也算成了截断。

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

**签到结果必须报「到账差值」，不能只报总额**（`checkin.js` 的 `computeGained`）。
上游 `claim` 只回 `{code:0, message:"success"}`，**从不告诉发了多少**；`status` 的
`credits`（实测恒为 150）是「签到可得」的固定值，**不等于实际入账**。早先只报
一个余额总额，用户看到「签到成功 + 4144.95」无从判断签到生效没有——实测
`status.checked_in` 与 `usage_summary` 会不同步（status 说没签、usage 已含奖励），
这时网关走「签到成功」分支而余额纹丝不动，被读成「显示的是旧积分」。
现在签到前后各取一次 `usage.remain`，差值即实际到账，并把「前 → 后」一并报出。
边界都如实给：差值为 **0** 说明奖励延迟入账（不粉饰成 null），为**负数**说明
上游结算异常或并发消耗（不吞掉）。快照失败才退回 `null`——**不补 0**，0 会被
读成「签到没发积分」。离线验证：`node test/verify-traework-gained.js`。

**TRAE 的账与千问、搭子都不同，界面三套分开显示**：搭子靠上游账单 + 余额游标，
千问是三个积分池，TRAE 是每个账号独立的一份 credits（签到领取）。
三边数字**不能相加**。

**每请求 spawn 一次 Node 子进程**（调 wasm_helper.mjs）。若实测成为延迟瓶颈，改成长驻子进程只需改 `src/qwenwork/bridge.js`——`wasm_helper.mjs` 已预留 `serve` 模式，上层 `chat.js` 不受影响。

用前缀而不是猜模型名的理由：两侧模型名会撞车（搭子有 `glm-5`，千问上游也是 GLM 系），猜错了两侧都返回 200，从响应里根本看不出来；且隐式路由会让同一名字今天走 A 明天走 B。未知前缀若静默跑到搭子，会拿到「看起来成功但完全不是想要的结果」，比直接 400 难查得多。


**`stable/` 是冻结快照**——网关闭包的拷贝（当前 **36 个 `.js`**：顶层 19 个 + `qwenwork/` 8 个 + `traework/` 9 个），**不随主目录开发改动**，保证 9080 不被开发中的代码波及。快照有自己的启动脚本 `stable/start-stable.bat`，默认用 `<repo>/data`——与开发实例共享同一份数据，这是有意的（账号池共用）。

**发布新版时不要简单地「把 `src/*.js` 覆盖过去」**，两个坑：

1. **`src/*.js` 这个 glob 漏掉子目录**——`qwenwork/` 与 `traework/` 共 17 个文件不在里面。漏了它们，网关能启动但通道直接不可用。
2. **会把管理端一起带进去**——`login-browser.js`、`task-runner.js`、`task-scheduler.js`、`web-gateway.js`、`records.js`、`points-agg.js` 都不属于网关闭包（快照历来只含网关），带进去会让快照无谓膨胀、还引入 playwright 依赖。

正确做法是**按依赖闭包复制**：从 `src/server.js` 出发递归解析 `require('./x')`，把闭包内的文件逐个复制到 `stable/src/` 同路径。这样既不会漏（`fallback-web.js`、`web-pool.js` 就是靠这个补上的——它们在 09-27 加入后快照漏了两版），也不会多。复制后必须做三件事：

- **逐字节比对**确认 `stable/src` 与 `src` 的闭包完全一致（数量相等且内容相同）
- 对快照跑 `node --check` 与一次**独立启动**（换个临时端口，如 `DUMATE2API_PORT=19099`），确认三条通道就绪
- 更新 `stable/SNAPSHOT_FROM.txt`：**指纹 + 算法 + 来源提交 + 本次覆盖了什么 + 验证记录**

**指纹算法必须写进 `SNAPSHOT_FROM.txt`**。历史上记过一个 `f7e7a810…` 但没记算法，后来试了二十多种拼接变体都复现不出来，那个值永久失效。现行算法：`sha256( 按相对路径排序后 [相对路径 + LF + 内容] 拼接 )`，UTF-8 编码。

管理端刻意**不代理模型协议**——网关已经在做，多一跳只会多一个故障点。所有进程通过 `data/` 目录下的文件通信，不通过 IPC。

**三套凭证，互不干扰**：

| 凭证 | 存储 | 特点 |
|---|---|---|
| 桌面凭证 | `%APPDATA%\qianfan-desktop-app\auth.json` | 客户端登录态，**同一时刻只有一份**；cookie 由 Go 后端读，本项目不接触 |
| 网页凭证 | `data/web-accounts.json` | 浏览器 cookie，**明文存**（必须原样重放），可多账号并存 |
| API Key | `data/keys.json` | 我们签发给调用方的，**只存 sha256** |

**关键分界**：桌面端同一时刻只有一个账号可用，网页端可以管多个。所以「两个账号都有效」只在网页端成立——仪表盘的「账号状态」表（桌面）与「账号健康快照」（网页）是两套数据，**不要互相替代**。

**网页账号的显示名一律走 `accounts.displayName()`，不要直接用 `a.name`**（2026-09-29 修）。`accounts.create()` 在用户没填名字时会写入占位名「账号 N」，而 `nickname` 早先**只在浏览器登录那条路径**（`/login/poll`）回填——手动粘贴 cookie 添加的账号走 `POST /web-accounts`，那条路径从不写 `nickname`。结果：这些账号的显示名永久停在「账号 1」，哪怕上游 `user/info` 明明返回了「张三」。用户报的「为什么显示账号 1 而不是真实用户名」就是这个。

两半修法，缺一不可：

1. **自愈回填**（`backfillNickname` / `backfillAll`，`admin/routes/accounts.js`）：触达上游的路径顺手补一次 `nickname`/`uid`。**三层保护，都因为这是读路径**：幂等（已有昵称不打上游）、**负缓存**（取不到昵称的账号 10 分钟内不重试——桌面凭证失效的账号永远取不到，没有这层每次进仪表盘都要白等一次超时）、**并发去重**（同账号并发只打一次）、**显式超时 8s**（`userInfo` 自身 20s 而前端 axios 30s，几个失效账号叠加就能把整页拖垮）。挂载点：`/dashboard`、`/checkin-all`、`/points-all`——只挂一处的话，「只签到不开仪表盘」的账号昵称永远补不上，`activity.jsonl` 会一直记「账号 N」。
2. **显示名解析**（`displayName` + `toPublic`，`accounts.js`）：优先级 **用户填的名字 > 上游昵称 > 占位名**。关键是识别占位名 `^账号\s*\d+$` 并跳过——**只匹配这一种形态**，用户真想起名叫「账号 1 号机」时不该被覆盖。

**`accounts.js` 的所有访问器必须经过 `toPublic()`**，这是「改了 9 个模块漏了 3 个调用点」的根因所在：早先 `list()` 解析了显示名而 `get()` 没有，同一个账号在两个接口里叫两个名字。收敛到一处后 `list`/`get`/`create`/`update` 必然给出同一个 `name`（原始标签在 `label`）。

**`get()` 现在返回对外形状（cookie 被抹掉），内部改盘一律用 `getRaw()`**——拿 `get()` 的返回值回写会把显示名写进 `name`、把 cookie 抹成 undefined。两者不要混用。

前端直接渲染 `a.name` 即可，**不要再写 `nickname || name` 兜底**——那会把优先级反过来（昵称压过用户填的名字）。

**历史记录（`activity.jsonl`）里的 `account` 是写入当时冻结的字符串**，改昵称前写的行会永远停在占位名。记录本身是既成事实不该改写，但**显示名是账号的属性**——所以 `/records` 读取时按 `account_id` 重解析一次（账号已删除则回落到冻结值）。

注意 TRAE/千问账号是另一套存储（`traework/auth.js`、`qwenwork/auth.js`），它们的 `nickname || uid` 兜底是合法的，不要一起改。离线验证：`node test/verify-display-name.js`。

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

**千问不需要「走客户端」，但仍有两处依赖安装目录**（别把它读成「要走客户端」）：

1. **官方 wasm**（`qoder_auth_wasm_bg.wasm`）——请求体必须由它签名，无法自实现。
   运行时从安装目录读（`wasm-path.js` 取版本号最大的目录），**不复制进仓库**。
   客户端升级后新 wasm 若签名规则变了，这里会失效——但实测 1.1.0 与 1.2.0 的
   wasm **完全相同**（同 md5），所以升级客户端本身不影响签名。
2. **machineId**（`credentials.machineId()` 读 `~/.qoderworkcn/.auth/machine_id`）——
   登录时生成，之后每账号固定不变（改了等于换设备）。**装过客户端才有这个值**；
   没装就退回随机 UUID，实测也能登录与推理。注意本机两个账号**共用同一个
   machineId**（都取自客户端那份），这是预期行为，不是 bug。

凭证本身（access/refresh token）走 `login.js` 的 **OAuth device flow + PKCE** 自取，
存在 `data/qwenwork-accounts.json`，**不碰客户端的 `auth-v2.dat`**——所以换账号
不需要开客户端，两个账号也能并存。`credentials.js` 现在只剩 `machineId()` 在用。

**`lastError` 是「最近一次结果」，不是「历史故障」**（2026-10-02 修）。三条不变量：

- **成功即清除**：`send()` 里一次请求成功就清掉该账号的 `lastError`（只在确实
  有值时写盘）。早先只在换票成功时清，于是一次瞬时失败（上游抖动的 403）会
  **永远挂着**——账号页显示的 403 其实几小时前就自愈了，用户被误导成「当前坏了」。
- **带时间戳**：`patch()` 集中给 `lastError` 打 `lastErrorAt`（写入 `lastError`
  时同步写入时刻，清空时置 null）。时间戳逻辑收敛在 `patch()` 一处：所有写
  `lastError` 的调用方（`index.js` 的 `markFailure`、`chat.js` 的换票失败）都走它，
  漏一处就会出现两种形状。
- **无时间戳 = 陈旧**（`web/src/utils/lastError.ts` 的 `lastErrorFresh`）。判据是
  「有 `lastErrorAt` 且未过 30 分钟」才算新鲜。**旧数据（本功能上线前写入的）没有
  时间戳，一律当陈旧**——第一版实现写反了（把「无时间戳」保守当成新鲜），结果
  acc2 那条修复前的旧 403 一直被标红，用户再次报「为什么还显示这个 403」。
  陈旧错误降级为灰色警告（`errorWhen` 显示「较早：」），仍显示错误串供排查。

  **为什么必须「无时间戳 = 陈旧」而不是「新鲜」**：`lastError` 只在**换票成功**或
  **请求成功**时才清——一个**不被使用**的账号（非主账号、主账号一直成功）永远
  拿不到这两次清空机会，一次瞬时失败就永久挂在那里，且永远不会有时间戳。
  把无时间戳当新鲜 = 把这类遗留错误永久标红。**宁可少报，也不要凭空报一个旧故障。**

  两个界面（仪表盘账号卡、账号管理页）共用这个工具，不要各写一份——上一版就是
  因为各写一份且判据写反，才出现「同一账号一处红一处不红」的漂移。旧的无时间戳
  遗留值已一次性清理（2026-10-02）。

**千问上游的 403 是间歇性的**（2026-10-02 实测）：同一账号、同一模型、同一分钟，
直接请求可能成功、`send()` 可能失败，几分钟后自愈。表现为 `Model is not available
for this user`（账号维度，网关会据此换号）。**这不是配置错误、不是额度、不是 token
问题**——遇到就重试。真正需要处理的是 **402**（额度真耗尽）和 **`换票失败`**
（refresh token 失效，要重新登录），这两种才会持续失败。

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
node test/traework-login.js login|checkin|chat   # TRAE 命令行自测（交互式，见下）
cd web && npm run dev      # 前端开发（Vite 5173，/api 代理到 9081）
cd web && npm run build    # 前端构建（vue-tsc 类型检查 + vite build → web/dist）
```

**`test/traework-login.js` 是不开管理端也能验证 TRAE 通道的入口**：`login` 生成授权链接（粘回调落盘）→ `checkin` 签到并查额度 → `chat "你好"` 发一条对话。凭证由它自己走 OAuth 换取，不依赖 TRAE 客户端。排查「TRAE 到底通不通」时比在界面里点更快。

**`npm test` 只依赖网关**：它直接打 9080，不需要起 mock。先确认 9080 在线（`curl :9080/health`）。

**`npm test` 之外还有两个单点探针**：`test/probe-oai.js` 与 `test/probe-anth.js` 各只打一种协议、把原始 SSE 打到 stdout，用来区分「网关翻译错」还是「上游返回错」——比跑全套 smoke 更快定位。两者都硬编码打 9080。

**这些脚本的端口都写死在 `req()` 里**（smoke / probe-oai / probe-anth 一律打 9080）。要在 9082 上跑同一套断言，临时把 `port: 9080` 换成读环境变量即可——不要改文件本身，那是开发实例与稳定实例共用的。

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

另有两个同样离线的千问专项验证（都不需要起服务）：
`node test/verify-qwen-discipline.js`（执行纪律的注入条件与幂等）、
`node test/verify-truncated-toolcall.js`（工具参数截断判定 + 纯工具调用轮次不误报 incomplete）。

另有一个 TRAE 专项离线验证（不需要起服务）：
`node test/verify-traework-gained.js`（签到到账差值计算，含 0/负数/快照缺失三种边界）。

另一个搭子专项离线验证（不需要起服务）：
`node test/verify-display-name.js`（账号显示名解析：占位名识别、优先级、空值边界）。

另一个千问专项离线验证（不需要起服务，假上游按账号返回预设余额）：
`node test/verify-qwen-daily-aggregate.js`（每日额度多账号合计口径：分子分母同源、
`/credits` 与 `/accounts` 两处相等、失败账号如实报出、每账号按各自峰值算）。

另一个千问专项离线验证（不需要起服务，拦截 https 层喂预设响应）：
`node test/verify-qwen-wallets-zero.js`（「每日额度被读成 0」的两层纠错：重试恢复、
`account-context` 交叉验证还原真实 daily、真实归零如实上报并标 retried、
免费扣完转付费不误判）。

**Qoder 专项**（两个都离线，不需要起服务）：

- `node test/verify-qoder-cosy.js`——签名算法，用**参考实现（Go）生成的确定性测试向量**
  逐字节比对（Encode / AES-128-CBC / MD5 / 身份 JSON 的 key 字母序），22 项。
  RSA 只验长度（PKCS#1 v1.5 padding 随机，无法逐字节比对）。
- `node test/verify-qoder-channel.js`——通道逻辑：模型 key 解析、body 构造（模型 key
  同时进 body 与请求头）、工具过滤、执行纪律注入幂等、信封错误解析、SSE 聚合含 credits、
  区域端点与归一化。
- `node test/verify-qoder-grants.js`——积分批次账本：到期时刻推导（RELATIVE_DAYS /
  缺字段 / 领取失败）、幂等（同 grantId 不重复写）、时间窗与账号过滤、正好到期的边界、
  「amount 是领取额不是剩余额」的数据缺口。

**`node test/qoder-cli.js` 是不开管理端也能验证 Qoder 通道的入口**（与 `traework-login.js` 同定位）：
`login [cn|global]` 生成授权链接 → `status` → `models`（带倍率排序）→ `quota` →
`checkin`（领积分）→ `chat "你好" [model]`（**默认用最省的 gfmodel**）→ `remove <id>`。
排查「Qoder 到底通不通」时比在界面里点更快。

离线自测的完整流程（无需安装 DuMate）：两个终端分别跑 `npm start` → `npm test`。

## 架构

依赖方向单向、无循环：

```
server.js ──→ discovery.js ──→ upstream-launcher.js
    ├──────→ anthropic.js ──→ budget.js
    ├──────→ google.js ─────→ budget.js
    ├──────→ responses.js ──→ budget.js + anthropic.js(modelmap)
    ├──────→ reqlog.js / modelmap.js / keys.js
    ├──────→ upstream-router.js ──→ channels.js（通道 id 单一来源）
    │                    ├──→ qwenwork/（直连，进程内）
    │                    └──→ traework/（直连，自持凭证）
    └──────→ fallback-web.js ──→ web-pool.js ──→ accounts.js
                              （桌面凭证不可用时把网页池包装成伪上游响应）
```

**`fallback-web.js` 是「伪上游」而不是第二条链路**：它把网页凭证池包装成带 `statusCode`/`headers` 的 EventEmitter，四个协议处理器原样复用——**不要为它重写翻译层**，那三套 SSE 状态机是踩了十几个坑才稳定的。

**`web-pool.js` 是 9084 与回落机制共用的账号池**，所以它同时被 `web-gateway.js`（独立进程）和 `fallback-web.js`（9080 进程内）依赖。改动它等于同时影响两个入口。

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

**直连通道失败时必须让翻译器收尾，不能裸 `res.end()`（2026-10-03 修，崩溃级）。**
`handleDirectChannel` 的 catch 原来无条件 `shim.end()` + `res.end()`，有两处后果，
且**三个直连通道（千问/TRAE/Qoder）全部中招**——实测触发它的是千问额度耗尽（402）：

1. 翻译器的 `upstreamRes.on('end')` 是**异步**触发的，在 catch 同步 `res.end()` 之后
   才跑，于是 `sendEvent` 调 `res.write()` 抛 `ERR_STREAM_WRITE_AFTER_END`。
   流式 res 的 `'error'` 事件**没有监听者** → 未捕获异常 → **网关进程直接退出**。
   实测：9082 于 23:51 退出、00:03 才重启，期间 cc-switch 连报 8 次
   「502 上游连接失败」；对旧代码跑 `test/verify-stream-error-termination.js`
   可稳定复现该崩溃。
2. 翻译器想补发的终结事件（`response.completed` / `message_stop`）因 res 已结束
   被丢弃 → Codex 报 `stream disconnected before completion: stream closed before
   response.completed`，用户看到「思考很久然后失败」，且那一轮记成 0 token
   （因为没收到任何 item）。

**关键认知：翻译器一进入就 `writeHead(200)` 并写 `response.created`，所以
`res.headersSent` 恒为 true**——「首帧前失败就回 4xx JSON」那条分支对翻译器路径
**永远不会走到**（只对 OpenAI 路径有效，它才延迟发头）。

修法（按路径分三种，不要合并成一种）：
- **有翻译器 + 已发头** → `shim.emit('error', e)`，让翻译器发它自己的失败终结事件
  （Responses 的 `response.failed`、Anthropic 的 `message_delta`+`message_stop`、
  Google 的裸关流）。**必须先补一个空 `error` 监听兜底**——翻译器若没有
  `'error'` 监听者，Node 会抛未捕获异常打挂进程（与上面第 1 条同一机制）。
- **无翻译器（OpenAI 路径）+ 已发头** → 写 `data: {"error":...}` + `data: [DONE]` 再关流。
  不写就是裸关闭，客户端只能报「响应未完成」。
- **未发头** → 回正经的 4xx JSON（只有 OpenAI 路径会走到）。

离线验证：`node test/verify-stream-error-termination.js`（11 项）。支持
`FAKE_QODER_MODE=post|pre` 两种错误形态——`post` 是「先吐一帧再报错」（与
`err.sent` 同形），`pre` 是「一帧都不吐就报错」（模拟额度耗尽）。

**上游转发只回调一次。** `forwardToUpstream` 用 `settled` 标志 + `once()` 包装；`collectAndFinish` 把 `end`/`aborted`/`error` 三路收拢到同一入口。上游 socket 出错时 Node 会同时触发 error 与后续事件，重复回调会让响应被写两次、客户端永久挂在半开的流上（表现为「输出突然停止」）。

**模型名兜底是唯一可行的容错。** 上游真实模型只有 `model-text` / `model-artifact-validate` / `glm-5`，传别的名字硬性报 `api not registered`。`mapModel` 查不到一律回落 `fallback`（默认 `model-text`），改 `data/model-map.json` 的 `fallback` 会影响全部未知模型名。

**`DUMATE2API_KEY` 是死变量。** `src/server.js` 顶部把它读进 `API_KEY`，但代码里从未参与任何校验（可以 grep `API_KEY` 确认只有那一处赋值）。真正的鉴权开关是 `DUMATE_REQUIRE_KEY=1` + `data/keys.json`。（README 已加说明标注它是历史遗留。）

**`model_allowlist` 只在配了白名单时才读请求体。** 网关鉴权段先判断 `key.model_allowlist` 非空才预读 body 取 `model`——否则给默认路径凭空加一次完整读取。结果存 `req._rawBody`，`readBody` 直接复用，**流只能读一次，重复读会拿到空串**。Google 路径的模型名在 URL 里，走正则从路径提取。

**引用代码位置时不要写行号。** 本文件历史上写过 `src/server.js:14` / `:709` 这类行号，改动几次后全部失效——后来者照着行号去看会读到无关代码。写函数名或常量名（`API_KEY`、`model_allowlist`），它们靠 grep 就能定位且不会漂移。

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
| `DUMATE_AUTO_CHECKIN_HOUR` / `_MINUTE` | `9` / `17` | 每日自动签到时刻（**两个都要**，只设 HOUR 不生效） |
| `DUMATE_BROWSER_PATH` | 自动探测 Edge/Chrome | 登录器找不到浏览器时手动指定 |
| `DUMATE_QWENWORK_AUTOSTART` | `auto` | `auto`=启用千问通道 / `off`=关闭（进程内直连，不拉起外部服务） |
| `DUMATE_QWENWORK_INSTALL` | 自动探测 | 千问办公安装根（wasm 探测失败时手动指定） |
| `CB_QWENWORK_WASM` | 自动探测 | 直接指定 `qoder_auth_wasm_bg.wasm` 的完整路径 |
| `DUMATE_QWENWORK_DAILY_CREDITS` | `100` | 千问每日免费额度的**配置兜底下限**（接口不返回上限，只作推断的下界） |
| `DUMATE_QWENWORK_MIN_MAX_TOKENS` | `16384` | 千问输出预算下限（与搭子的 `DUMATE_MIN_MAX_TOKENS` 分开） |
| `DUMATE_QWENWORK_DEFAULT_MAX_TOKENS` | `131072` | 千问**默认**输出预算（客户端未给 `max_tokens` 时；搭子用 `DEFAULT_BUDGET=32768`，但会被 FLOOR 抬到 65536——**下限优先于默认值**）。取上游上限，见上文实测 |
| `DUMATE_QWENWORK_AGENT_DISCIPLINE` | 未设（注入） | 设 `0` 关闭「执行纪律」注入（见上文「千问通道必须给带工具的请求注入执行纪律」） |
| `DUMATE_QWENWORK_CREDIT_CACHE_MS` | `30000` | 千问余额缓存时长，避免每次请求都打站点接口 |
| `DUMATE_QWENWORK_ACCOUNT` | 未设 | 千问指定用哪个账号（填账号 **id**）。优先级：**环境变量 > 账号文件里的 `preferred` 标记 > 池里第一个**。环境变量是临时覆盖（改启动参数不改文件），删号后「第一个」会变，所以只作兜底 |
| `DUMATE_TRAEWORK_AUTOSTART` | `auto` | `auto`=启用 TRAE 通道 / `off`=关闭（与 `DUMATE_QWENWORK_AUTOSTART` 同形） |
| `DUMATE_TRAEWORK_MIN_MAX_TOKENS` | `16384` | TRAE 输出预算下限（三通道各一套，不要互相套用） |
| `DUMATE_TRAEWORK_MODELS_CACHE_MS` | `300000` | TRAE 模型表缓存时长（5 分钟）。模型表只在登录/刷新时变，不必每次打上游 |
| `DUMATE_WEB_FALLBACK` | 未设（开启） | 设 `0` 关闭「桌面凭证不可用时回落到网页池」（见上文回落机制）。关闭后桌面凭证失效即请求全失败 |
| `DUMATE_POINTS_METER` | 未设（开启） | 设 `0` 关闭搭子的余额游标采集（`points-cursor.js`）。关闭后请求日志不再有逐条消耗 |
| `DUMATE_LAG_MONITOR` | 未设（开启） | 设 `0` 关闭事件循环卡顿监控（`startLagMonitor`）。开启时同步代码卡顿超阈值会打日志 |
| `DUMATE_LAG_WARN_MS` | `2000` | 卡顿监控的告警阈值（ms）。低于此值的 GC 停顿与大请求编码不报 |
| `DUMATE_WEB_BASE` | `https://www.dumate.cn` | 搭子网页端基址。只在需要指向测试环境时改 |
| `DUMATE_WEB_TIMEOUT` | `20000` | 搭子网页接口超时（ms）。**注意前端 axios 是 30s**，改大这里会让整页请求先超时 |
| `DUMATE_GATEWAY_HOST` | `dumate-svc.baidu.com` | 网页凭证换模型 token 的目标主机。上游换域名时改这里 |
| `DUMATE_UPSTREAM_CWD` | DuMate 安装根 | 拉起 `dumate-main-server.exe` 时的工作目录。后端读相对路径配置时用得上 |
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
| `qwenwork-accounts.json` | 千问自持凭证账号池（**含 refresh token，等同密码**） |
| `qoder-accounts.json` | Qoder 自持凭证账号池（device flow 换取，含 refresh token） |
| `qoder-grants.jsonl` | Qoder 积分批次账本（**签到领取记录**，用于过期提醒；上游无逐批余额接口） |
| `traework-accounts.json` | TRAE 自持凭证账号池（OAuth 换取，含轮换的 refreshToken） |
| `traework-credits.jsonl` | TRAE 逐请求积分归因（按账号的 consumed 游标，见 `traework/credits.js`） |
| `points-cursor.jsonl` | 搭子的余额游标（每请求一条，相邻差值即该请求成本） |
| `browser-profile/` | 浏览器登录器用的受控 profile 目录（`DUMATE_BROWSER_PATH` 找不到浏览器时才用） |

**两个 `data/` 目录的陷阱**：`DUMATE_ADMIN_DATA` 决定数据目录，管理端与网关必须一致，否则读到的账号/埋点不同。`stable/` 快照若也跑起来，默认用 `<repo>/data`——与开发实例共享同一份数据，这是有意的（账号池共用）。

**`stable/` 手工启动会退回到一个空目录。** `reqlog.js` 的 `ROOT = path.resolve(__dirname, '..')`——stable 副本的 `__dirname` 是 `stable/src`，所以**未设 `DUMATE_ADMIN_DATA` 时埋点落 `stable/data/`**。该目录当前不存在（已被清理），但风险仍在：手工启动且不带环境变量时，网关会退回到这个空目录，**里面没有任何凭证**，千问与 TRAE 通道直接不可用，且 9083 管理端读的是 `<repo>/data`、看不到 9080 的流量——排查时会得出「请求根本没经过网关」这种错误结论。

所以启动 9080 **必须**走 `start-stable.bat`（它设了 `DUMATE_ADMIN_DATA=%~dp0..\data`），或手工带上该变量。历史上 9080 曾被手工启动过（没有该变量），埋点因此落在 `stable/data/`——那段数据已合并回 `<repo>/data`。

**核对 9080 的埋点时先确认它用的是哪个目录**：`stable/start-stable.bat` 启动的看 `<repo>/data/requests.jsonl`，手工启动且未设变量的看 `stable/data/requests.jsonl`。

`keys.js` 的 CIDR 匹配是 **fail-closed**：非法条目返回 false（写错一条 CIDR 会让这把 key 对所有来源拒绝，而非意外放行）。token 比对逐条走 `timingSafeEqual`，避免通过响应耗时逐字节猜 token。

## 平台与依赖

- **仅 Windows**：依赖 PowerShell / CIM 查询进程命令行与监听端口、`%APPDATA%\qianfan-desktop-app\auth.json`、`taskkill`。
- **网关本身零第三方依赖**（`stable/` 快照更是如此），只用 Node 内置 `http`/`net`/`child_process`/`fs`/`crypto`。Node >= 18。
- **根 `package.json` 有 `playwright-core`**，但只被管理端的浏览器登录器 `src/login-browser.js` 用到——用来打开受控窗口抓 cookie（系统浏览器 cookies 库运行时被独占锁，读不到）。复用系统已装的 Edge/Chrome，不下载 Chromium。
- **前端有依赖**（Vue 3 + ant-design-vue + Tailwind + ECharts），在 `web/` 下单独 `npm install`。

## 管理端模块（`src/` 下除网关外的部分）

**先分清两类**，它们的归属决定了改动要不要同步进 `stable/` 快照：

- **属于网关闭包**（会进快照）：`dumate-web.js`、`accounts.js`、`web-pool.js`、`points-cursor.js`。它们被 `server.js` 的依赖闭包引用（回落链路与余额游标都要用），**改这些要同步快照**。
- **纯管理端**（不进快照）：`web-gateway.js`、`task-runner.js`、`task-scheduler.js`、`login-browser.js`、`records.js`、`points-agg.js`、`admin/`。9080 网关不加载它们。

> 判断某模块属于哪类，**不要凭直觉**——`records.js`（操作记录）和 `points-agg.js`（额度包聚合）看着像核心逻辑，实际只被管理端路由引用，不在快照里。用依赖闭包算一次最可靠（见下文「`stable/` 是冻结快照」）。

| 模块 | 职责 |
|---|---|
| `dumate-web.js` | 网页端 API 封装（签到 / 任务 / 抽奖 / 积分）。**网关闭包内**——回落链路靠它调网页接口 |
| `accounts.js` | 网页账号存储，cookie **明文存**（必须原样重放）。**网关闭包内**（`web-pool.js` 依赖）。显示名解析 `displayName()` / 对外序列化 `toPublic()` 都在这里，见下文约定 |
| `web-pool.js` | 网页凭证账号池，轮询 + 故障转移。**被两个入口共用**：9084 独立网关 + 9080 的回落链路 |
| `web-gateway.js` | 9084 独立网关，用网页凭证跑模型（纯管理端，不进快照） |
| `task-runner.js` / `task-scheduler.js` | 任务自动跑 + 后台轮询（纯管理端） |
| `records.js` | 统一操作记录（签到/任务/抽奖）。**纯管理端**——网关不加载它 |
| `points-agg.js` | 额度包聚合（按来源 / 按发放日 / 临期 / 已过期未用完）。**纯管理端**。本地后端与网页账号拿到的是同一份额度包结构但字段来源不同，两份都要得出同样的派生视图——收敛在这里，否则「一边按到期日、一边按发放日判断还在不在发」这种口径漂移必然发生 |
| `points-cursor.js` | 单请求积分成本（余额游标差）。上游账单无法归因到具体请求（同一时间窗有 1~3 条候选扣费，硬挑一条等于编数字），改用「每条请求结束后记一次余额、相邻两次差值即后一条的成本」。**每账号一条串行队列**——丢一条游标会让下一条的差值跨过两条请求，静默算错，所以宁可排队也不缺档 |
| `login-browser.js` | 浏览器登录器（唯一依赖 playwright-core 的地方，纯管理端） |
| `admin/router.js` | `/api/admin/*` 路由分发。**路径匹配锚定整串**，所以 `/models/map` 不会误吞 `/models/map/reset`；注册时 `path: ''` 与前缀拼成 `/api/admin/web-accounts`，`mount` 做了去尾斜杠 |
| `admin/store.js` | JSON / JSONL 原子持久化（先写 `.tmp` 再 `rename`）。管理端的配置写盘都走它 |
| `admin/iputil.js` | 客户端来源 IP。管理端只监听 127.0.0.1，所以直接取 TCP 对端；**没有 TRUST_PROXY 判定**——挂反代前必须先补，否则限流/锁定会按代理 IP 统计 |
| `admin/routes/traework.js` | TRAE Work 通道的管理接口：`/status` 通道健康+账号列表（mode=multi，可增删）、`/models` 模型表（只读）、`/credits` 各账号额度与签到状态、`/checkin` 手动签到（幂等）、**`/login/url` + `/login/callback` 两步 OAuth 登录**、`DELETE/PATCH /accounts/:id` |
| `admin/routes/qwenwork.js` | 千问办公通道的管理接口：`/status` 通道健康、`/credits` 三个池、`/credits/daily` 按天聚合、`/credits/records` 逐笔明细、`/models` 模型表、**`/account` 登录态详情（只读）**、**`/accounts` 账号（`mode='single'` 表示单账号直连，不可增删）** |
| `admin/routes/accounts.js` | 搭子网页账号的管理接口（签到/抽奖/积分/记录）。**回填与显示名的逻辑都在这里**（`backfillNickname` / `backfillAll`），属于管理端、不进快照 |
| `admin/routes/*.js` | 其余管理 API，按 `mount()` 挂载到 `/api/admin/<前缀>` |

**千问登录态只读，管理端绝不写入。** 它存在官方客户端的 `auth-v2.dat` 里（Electron safeStorage：DPAPI 解 `Local State` 的 `encrypted_key` → 32B AES key → AES-256-GCM 解密）。官方客户端和我们各写一次会互相把对方的登录态刷掉，所以换账号必须开客户端操作。**不复制这个文件到 `data/`**——它会过期，复制一份立刻失效。`refresh_token` 过期（`refreshExpired`）要提前告警：access token 到期后无法自动续期。

**API Key 可选绑定通道**（`keys.js` 的 `channel` 字段，`''` = 不限）。网关鉴权段用 `upstream-router.resolve(model).channel` 解析请求走哪条通道再传给 `validate()`——设了 `qwenwork` 的 key 调搭子模型会被 403 `channel_not_allowed`。注意鉴权段**只在 key 真的配了模型白名单或通道绑定时才预读请求体**，否则给默认路径凭空加一次完整读取。key 用量按通道分开统计（`usage.channels`），因为网关按模型名前缀分流、不按 key 分流，同一把 key 可能两条通道都在用。

**两套「用量」视图不要互相替代**：`stats.js` 与 `usage.js` 都读 `data/requests.jsonl`，但 `usage.js` 还额外查上游计费记录——本地只知道「发了多少 token」，不知道「扣了多少积分」，计费规则在上游。`reqlogs.js` 则是逐条明细与单条详情（聚合看趋势、明细查个案）。

**`chatlab.js` 刻意绕过密钥与 IP 管控**：它只要求管理员会话，走的是与 9084 同一套账号池、消耗真实积分。定位是「在管理端里验证某个模型名能不能跑通」，不必先去签发密钥。与 9084 的分工是：9084 面向外部客户端、带鉴权、做协议兼容；chatlab 是内部试调、返回便于展示的结构化数据（含每条回答的实测消耗）、不做协议翻译。

**`autotask.js` 只给签到做定时，抽奖只留手动**：签到幂等（当天已签就跳过），多跑无害；抽奖消耗次数且不可逆。定时配置落盘到 `data/auto-checkin.json`——定时器只活在进程内，重启后得知道上次开没开、几点跑。

## 前端（`web/`）

Vue 3 + Vite + ant-design-vue 4 + Tailwind + ECharts（按需引入，不用全量，省约 1MB 首屏）。开发时 Vite 把 `/api` 代理到 9081（`vite.config.ts`），**改的是哪个管理端端口就要对应改这里**——代理写死 9081，跑开发实例 9083 时前端页面会拿到 9081 的数据。

**设计方向是深色控制台，不是浅色后台。** 这套系统的本体是「模型网关的控制室」：请求量、账号池、上游健康、积分流水，信息密度高、看数时间长。三层共享设施各管一段，**改一处全站生效**：

| 位置 | 管什么 | 为什么必须在这一层 |
|---|---|---|
| `App.vue` 的 `ConfigProvider` | AntD `darkAlgorithm` + token | Select 下拉、Modal、DatePicker、Message 这些浮层不在卡片内，scoped 样式够不到，只有 token 能一次改干净 |
| `src/style.css` 的 `--lab-*` | 分层底色、青色信号色、卡片/表格/按钮基线 | 各页面各写一遍圆角阴影必然漂移 |
| `tailwind.config.js` | **把 `slate` 槽位整体重映射为控制台灰阶** | 全站 100+ 处 `text-slate-400` 这类工具类因此一次性换到深色语义。**新增页面继续用 `slate-*`，不要为了「准确」改成语义色名**——那样等于把这层映射废掉，回到逐页维护 |
| `src/utils/chartTheme.ts` | 图表色板与轴样式 | 分类色按固定槽位取用、不按排名重排（否则筛掉一条序列会让其余序列换色，读者刚建立的对应关系就废了） |

**通道切换是全局状态，不是各页各存一份。** `web/src/stores/channel.ts` 管「当前在看哪个通道」，持久化到 localStorage，顶栏切（不是侧栏——侧栏可折叠，折叠后切换器会消失，而通道是任何时候都不该丢的上下文）。`CHANNELS` 里的 `menuKeys` 是该通道**有意义**的菜单白名单：千问与 TRAE 都没有「操作流水」（无签到/抽奖/任务体系），账号管理只做只读展示。

**「任务记录」已并入「积分明细」，不再是独立页**（2026-09-29）。判定依据是**职责而非数据来源**：

- 签到 / 任务 / 抽奖 / 自动发放这四类记录，**全都是积分的来源**。积分明细页其余区块（额度包、按来源、每日发放、逐笔发放）回答的是同一个问题——「积分从哪来、怎么没的」。拆成两页会让「查一笔积分的来历」在页面之间来回跳。
- 账号管理页保留的是**操作台**：增删账号、跑任务、开轮询。记录是结果，不该堆在操作台上。它原来那块「任务执行记录」与任务记录页的「操作明细」是**同一份数据**（`task-runner.js` 的 `appendLog` 同时写 `task-runs.jsonl` 与统一记录流 `records.append`），留着就是同一件事三个视图，已删掉；本页只留「跑完的即时反馈」提示条，历史去积分明细查。
- 因此 `/records` 路由、`RecordsView.vue`、侧栏菜单项、`menuKeys` 里的 `records` 全部移除。后端接口（`/web-accounts/records`、`/web-accounts/checkin-calendar`）**保持不变**，只是换了调用方。

**别按「数据存哪个文件」划页面，按「用户要回答什么问题」划。** 同一个 `records.js` 的数据既支撑「操作流水」也支撑签到日历，它们是同一页的两个视图；而 `task-runs.jsonl` 虽然单独落盘，内容却是 `records` 的真子集——按文件划分会把一条任务拆到两个页面。

**各页面必须 `watch` 通道变化并重新拉数据**，不能只在 `onMounted` 读一次——否则顶栏切了、页面还是旧通道的内容。两个数据源结构不同的页面（登录态、积分明细、账号管理、模型管理、API Key）用 `v-if="isQw"` / `<template v-else>` 分开两套模板，共用同一个路由；只差筛选条件的页面（用量统计、请求日志、聊天测试台）同一套模板，只换请求参数。

**千问办公的账与搭子完全不同，界面必须分开显示**：搭子靠上游账单 + 余额游标（`points-cursor.js`），千问是三个积分池（`daily` 免费 / `monthly` 订阅 / `longterm` 充值）按 `req_id` 归因。两边数字**不能相加**。千问的「每日上限」接口不返回，由「观测峰值 + 配置兜底」推断（`credits.js` 的 `dailyUsageFromBalance`），界面要标出 `limitSource` 是 `observed` 还是 `config-lower-bound`。

**千问的每日额度是账号级的，池子卡的余额与分母都必须是全账号合计**（2026-09-30 修）。用户报「两个账号每日额度应该是 200，今天都还没用」——根因是 `/api/admin/qwenwork/credits` 只读**主账号**（`authStore.preferred()`），池子卡显示单个账号的 100；而同一页顶部「积分余额」卡读 `/accounts` 的 `summary.pointsTotal`，**本来就是全账号合计** = 200。同页两个数字口径不同，被读成「少算了一个账号」。

三条不变量，改动时别破坏：

- **分子与分母同口径**。每个账号各有一份每日免费额度（各自 00:00 重置），所以池子卡的余额是合计、分母也必须是合计（`dailyCap = 单账号上限 × 账号数`）。只把分子改成合计会得到「200 / 100」这种读不出来的数。
- **`/credits` 与 `/accounts` 的账号范围必须同源**（都走 `authStore.list()` 全量，不只 `usable`），否则「顶部合计」与「池子合计」还是会差。余额查询失败的账号不计入合计，但必须在 `failedAccounts` 里如实报出——否则部分和被读成全量。
- **两个分母分开给**：`dailyCap`（合计，池子卡用）与 `dailyCapPerAccount`（单账号，账号健康快照每张卡用）。账号快照问的是「这一个号今天还能用多少」，那里**不能**用合计分母。

每个账号的 `limit`/`freeUsed` 仍按**各自**的观测峰值算（峰值文件按账号分桶），再相加；只要有一个账号没校准，`freeUsed` 整体给 `null`——部分求和会低估消耗，比不给数字更容易被误读。聚合值统一 4 位小数（与归因记录口径一致），否则浮点累加会外传 `199.99349999999998` 这种噪声。离线验证：`node test/verify-qwen-daily-aggregate.js`。

**每日额度是「每天 00:00 自动重置」，不需要当天先使用一次**（2026-09-30 实测确认）。重置时刻就是 wallet 的 `valid_to`（`2026-10-01T00:00:00+08:00`）。证据：账号 2 当天**零请求**，前一日收尾 `4.9657`，次日读到满额 `100`——中间没有任何请求。所以「必须先跑一次才刷新」这个说法不成立。

但用户看到的那个「0」是**真实存在**的，成因不是「没刷新」，而是 `/user/wallets` 偶尔返回坏读——它会把**每日免费额度读成 0**（付费池仍准确）。`fetchWallets` 现在有两层纠错：

1. **重试一次**（针对「三池全 0 + `active_wallets` 空」这种最明显的形态）：重试即恢复 → 用重试结果（瞬时抖动，不标任何标记）。
2. **交叉验证**（2026-10-02 加，针对重试也没恢复、以及更隐蔽的形态）：只要 `daily` 读数为 0，就去 gateway 的 `account-context` 取 `quota.remaining`。它是**权威口径**且**恰好等于三池之和**（实测 `100 + (−4.8222) = 95.1778`），所以 `daily = remaining − monthly − longterm` 能还原出真实的每日额度。还原出的 daily > 0.005 就采用并标 `dailyCorrected: true`（经 `correctedAccounts` 汇总到界面，显示「已校正」而非「已用尽」）。

**为什么触发条件从 `allZero` 放宽到「daily 读数为 0」**：账号 2 的坏读形态是「`daily=0` 但 `longterm` 为负」，三池不全是 0，**根本不进 `allZero` 分支**，却同样把每日额度显示成了 0——用户 2026-10-02 报的正是这个（界面显示「每日额度 0.00 积分」，而 `account-context` 报 `remaining=95.1778`）。只看 `allZero` 会漏掉它。

**不能一律把 0 当读失败**：真·额度耗尽时三池确实都是 0，那时显示 0 是**正确的**（历史上 95 条 `daily=0` 全部伴随付费池 >0，即免费扣完转扣付费）。判据是「还原出的 daily > 0.005」——真耗尽时 `remaining` 也≈0，差值不 > 0.005，于是不校正、如实报 0 + `retried`。**不要**改成「读数为 0 就报错」或「读数为 0 就沿用旧值」，前者会掩盖真实耗尽，后者会长期显示过期数字。`account-context` 取不到（网络错/结构变了）时也不校正，回落成「如实报 0 + `retried`」，不编数字。离线验证：`node test/verify-qwen-wallets-zero.js`（含「谎报 0 被校正」「付费池为负时还原」「真耗尽不误判」「account-context 取不到则回落」四类）。

**模型管理页的三条通道共用一套骨架，但账各自独立**（2026-09-29 对齐）。页面结构固定为「通道元信息行 → 模型信息表 → 该通道的额度卡 → 通道专有区块」：

- **通道元信息行**（`.qw-channel-row` 三联卡）：TRAE 给「可用账号 / 当前账号 / token 状态」，千问给「账号 / 套餐 / token 状态」，搭子给「上游端口 / 桌面登录账号 / 凭证来源」。放的是**通道级**信息，不随模型变。
- **模型信息表**：三条通道共用 `ModelInfoTable.vue` + 后端 `/models/info?channel=`。**倍率只有 TRAE 有**（上游下发），搭子与千问如实 `null` → 显示「—」，**不估算**——编一个单价会让人以为真能按那个价扣。
- **额度卡**：回答「这些模型花的是哪份额度」。TRAE 是单 credits（签到补充）、千问是三池、搭子是上游账单 + 余额游标。**三套账的数字不能相加**，所以各写各的卡片，不抽成一个通用组件。

**搭子模型页的「凭证来源」必须区分「未加载」与「已回落」**：`channelStore.infos['dumate']` 为空时显示 `—`，不能默认成任一侧。桌面凭证不可用时会自动回落到网页池（`fallback-web.js`），把一次「还没拉到状态」显示成「网页凭证回落」等于凭空报一个不存在的故障。

**搭子的「今日消耗」取 `/usage/overview` 的 `cards.today.consumed_points`**（来自上游账单，`points-cursor.js` 的余额游标差）。这个字段**只有搭子有**，直连通道为 `null`——界面据此显示「上游未给出账单」而不是 0，0 会被读成「今天没花钱」。

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
