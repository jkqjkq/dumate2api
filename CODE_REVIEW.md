# dumate2api 全项目通读报告

> 通读范围：`src/` 73 个 js/mjs（25 顶层 + admin 20 + qwenwork 10 + traework 10 + qoder 8）、`web/src` 全部、`test/` 21 个脚本、`stable/` 快照、根目录四份文档、`data/` 落盘实况。
> 通读方式：核心链路（网关、四条通道、凭证层）逐文件精读；外围（admin 路由、前端、测试）由 6 路子代理并行精读后回报，其中的关键指控由本人回到源码复核。
> 本文所有结论标注证据（函数名 / 常量名 / 文件名），不写行号——项目约定行号会漂移。

---

## 一、项目定位与进程拓扑

把百度搭子（DuMate）桌面客户端内置的本地 OpenAI 兼容端点，扩成**四通道、三协议**的模型网关，同时是一个**进程管理器**（无 GUI 拉起 `dumate-main-server.exe`）。

| 进程 | 端口 | 入口 | 职责 | 当前状态（通读时） |
|---|---|---|---|---|
| DuMate 后端 | 8980 | `upstream-launcher.js` 拉起 | 真实模型链路 | 运行中（pid 12008） |
| 稳定版网关 | 9080 | `stable/src/server.js` | 对外长期服务 | **未运行** |
| 开发网关 | 9082 | `src/server.js` | 开发调试 | 运行中（pid 4172） |
| 开发管理端 | 9083 | `src/admin/server.js` | `/api/admin/*` + 托管 `web/dist` | 运行中（pid 10984） |
| 多账号网关 | 9084 | `src/web-gateway.js` | 网页凭证跑模型 | 未运行 |

四通道靠**模型名前缀**显式分流（`src/upstream-router.js` 的 `UPSTREAMS` / `resolve`）：无前缀 → 搭子（8980 转发）；`qwen/` → 千问办公；`traework/` → TRAE Work；`qoder/` → Qoder。三条带前缀的都是 `direct: true` 的进程内直连（没有本地端口，走 provider 而不是转发），未知前缀返回 `unknown_channel` 而不是回落——理由是模型名会撞车（搭子有 `glm-5`，千问上游也是 GLM 系），静默回落会拿到「看起来成功但完全不是想要的」结果。

---

## 二、代码地图

### 网关核心（`src/` 顶层）
- `server.js`（1537 行）：唯一 HTTP 入口。路由分发、鉴权、`forwardToUpstream` / `forwardWithFallback`、`handleDirectChannel`（三条直连通道的统一入口，用 PassThrough 冒充上游响应把回调桥接给三个翻译器）、`translateStreamToAnthropic`、`logRequest` 埋点、`startLagMonitor` 卡顿监控。
- `anthropic.js` / `responses.js` / `google.js`：三个协议的双向翻译层。注意 `anthropic.js` **只有非流式转换**，Anthropic 的 SSE 状态机在 `server.js` 的 `translateStreamToAnthropic` 里。
- `budget.js`：四套输出预算策略（`resolveMaxTokens` / `resolveQwenMaxTokens` / `resolveTraeworkMaxTokens` / `resolveQoderMaxTokens`），`server.js` 的 `resolveBudget` 按 `target.budgetKind` 选用。
- `discovery.js`：端口发现四级降级（已知端口探活 → 进程命令行 `--port` → 监听 socket → 自拉后端），全异步版避免 PowerShell 冷启动阻塞事件循环。
- `upstream-launcher.js`：逆向成果。靠 `DUMATE_LOGIN_MODE=standalone` 等四个环境变量让 Go 后端在无 Electron 上下文时启动。
- `modelmap.js` / `keys.js`：按 **mtime 失效**重读的配置层（网关与管理端是两个进程，不能在启动时读一次）。
- `channels.js`：通道 id 单一来源（`CHANNELS` / `label` / `normalize` / `belongs` / `effChannel`），被 keys、admin 校验、usage、reqlogs 四处共用。
- `reqlog.js`：JSONL 埋点（32MB 轮转）、`newReqId`、`pickUsage`、`usageFromSSE`。
- `upstream-account.js`：埋点里「这条请求实际用了哪个账号」——权威来源是 provider 上报的 `req._upstreamAccount`，只有搭子有兜底。
- `fallback-web.js` / `web-pool.js` / `accounts.js` / `dumate-web.js`：搭子网页凭证链路（回落机制 + 账号池 + 网页 API 封装）。
- `points-cursor.js` / `points-agg.js` / `records.js`：搭子的余额游标（逐请求成本）、额度包派生视图、统一操作记录。
- `model-info.js`：跨通道模型元信息，每个字段带 `source`（`upstream` / `measured` / `config`），取不到一律 `null` 不估算。
- `web-gateway.js`（9084）、`task-runner.js` / `task-scheduler.js`（网页账号任务自动化）、`login-browser.js`（playwright-core 受控窗口抓 cookie）。

### 直连通道
- `qwenwork/`（10 文件）：请求体必须由官方 wasm（`wasm_helper.mjs`）生成，`bridge.js` 每请求 spawn 一次子进程；`credits.js` 做三池余额归因与每日峰值推断。
- `traework/`（10 文件）：自持 OAuth 凭证；`chat.js` 含 `normalizeToolCall` 与 `buildBody`；`checkin.js` 的 `computeGained` 报到账差值；`device.js` 从 uid 确定性派生设备三件套。
- `qoder/`（8 文件）：`cosy.js` 纯本地签名（RSA 加密临时密钥 + AES-128-CBC 加密身份 + MD5 签名 + 自定义 base64 的 `encode`）；`grants.js` 积分批次账本；`session.js` 非签名接口与签到。

### 管理端与前端
- `src/admin/`：`router.js` 的 `mount` + `anchor`（`:seg` → `([^/]+)`、整串锚定、按注册顺序取首个匹配）驱动约 100 条 `/api/admin/*` 路由；`auth.js` scrypt（N=2^18）+ HMAC 会话；15 个路由文件覆盖账号、积分、模型、日志、四条通道、Key、试调台。
- `web/`：Vue 3 + Vite + ant-design-vue + echarts。**hash 路由**（`createWebHashHistory`），9 个业务页 + `/records` 重定向 + 兜底重定向；`stores/channel.ts` 是跨页面的通道上下文（持久化到 localStorage）；`api/client.ts` 是 axios 实例（`baseURL: '/api/admin'`、`withCredentials`、401 跳登录）。

### 测试与快照
- `test/`：端到端（`smoke.js` 32 项断言、`verify-ccswitch.js` 仅打印、两个探针）必须打 9080；离线验证 13 个（cosy/channel/grants/encode-perf、qwen 三件、truncated-toolcall、traework 两件、display-name、stream-error-termination 自起端口）；两个 CLI（`traework-login.js`、`qoder-cli.js`）需真实上游与凭证。
- `stable/`：43 个 `.js` + `wasm_helper.mjs` 的冻结快照，`SNAPSHOT_FROM.txt` 记录指纹算法（按相对路径排序后 `[相对路径 + LF + 内容]` 拼接取 sha256）与验证记录。

---

## 三、关键机制（读代码后的准确口径）

**预算钳制**：搭子 `FLOOR=65536` / `CEIL=131072`；千问 `QW_FLOOR=16384`、`QW_DEFAULT=131072`；TRAE `TW_FLOOR=16384`；Qoder `QD_FLOOR=16384`。`FLOOR=0` 表示关闭策略、客户端值原样透传。

**翻译层的三处硬约束**（都由实测修正，改动会回归）：
1. Anthropic 的 `message_delta` 必须在 `content_block_stop` 之后——`translateStreamToAnthropic` 只记 `lastFinishReason`，流末统一补发。
2. Responses 的 `reasoning` 与 `function_call` 是并列 item，开 function_call 前必须 `closeReasoningLater()`。
3. 四个解析点一律用 `StringDecoder`（跨 chunk 汉字会变 U+FFFD）。

**直连通道的失败收尾**（`handleDirectChannel` 按「有无翻译器 / 头是否已发」三分支，不可合并）：已发头且有翻译器 → `shim.emit('error')` 让翻译器发自己的失败终结事件（`emit` 前必须补空 `error` 监听，否则未捕获异常打挂进程）；无翻译器的 OpenAI 路径 → 写 `data: {"error":...}` + `[DONE]`；未发头 → 正经 4xx JSON。

**埋点与归因**：`req_id` 是唯一关联键（`newReqId`），千问/TRAE/Qoder 的积分归因都靠它配对；`logRequest` 用 `res._logged` 去重；余额游标只对 `channel === 'dumate'` 记。

**通道可用性预检**：`router.availability` 只对 `qwenwork` / `traework` 调 `status()`，其余一律返回 `{ok:true}`（见问题 3）。

---

## 四、发现的问题（按严重度，标注核实状态）

### P0 —— 功能性失效

**1. Qoder 积分账本永远写不进，过期提醒实际不工作。**（本人核实）
`session.claimCampaign` 的返回对象是 `{ok, status, benefit, replayed, grantedAt, validityMode, validityDays, amount, modelScope}`——**没有 `grantId`，也没有 `campaignKey` / `validityEnd`**。而 `checkin` 把它交给 `grants.fromClaim(r, account)`，`fromClaim` 取 `grantId: r.grantId || ''`，`grants.record` 首行是 `if (!entry || !entry.grantId) return false`。于是整条写入路径必然返回 false。
落盘证据：`data/qoder-grants.jsonl` **只有 1 行**（`grantId: 01a0fce0-…`、`campaignKey: act-20260930-468`、`validityDays: 30`），文件最后修改 2026-10-02 22:57；而 10-03 有签到活动（`qwenwork-credits.jsonl`、`traework-credits.jsonl`、`requests.jsonl` 均到 10-03 22:33）。即那一行是开发期某版临时实现的残留，此后账本再无写入。
附带：`fromClaim` 的 `ABSOLUTE` 分支依赖 `r.validityEnd`，而该字段从不返回——分支不可达。
修法：`claimCampaign` 从 `d.grantId` / `d.benefit.grantId` 带出幂等键，并带出 `campaignKey`。

### P1 —— 崩溃 / 静默失败风险

**2. 千问 `postStream` 收到 `[DONE]` 后不停手，且 `end` 时再无条件补一次。**（本人核实代码路径；触发依赖上游行为）
`flushLine` 里 `if (raw === '[DONE]') { onChunk('[DONE]'); return; }` 只结束当前行的处理，后续帧照旧 `onChunk`；`res.on('end')` 里又 `onChunk('[DONE]')` 一次。
后果一：客户端可能收到两个 `[DONE]`。
后果二（更重）：`server.js` 的 `handleDirectChannel` 在收到 `inner === '[DONE]'` 时 `shim.write('data: [DONE]\n\n')` 后立刻 `shim.end()`，而该回调里所有 `shim.write` **没有守卫、也没有 try/catch**。若 `[DONE]` 之后还有帧到达，`write` 抛 `ERR_STREAM_WRITE_AFTER_END`，抛点在 `https` 的 `res.on('data')` 回调里——不在 `await provider.send` 的 try 覆盖范围内，属未捕获异常，可直接打挂网关进程（与 `responses.js` 里那个「send 必须自带 ended 守卫」的教训同源，但 OpenAI 直连路径没享受到同样的保护）。

**3. `router.availability` 漏了 `qoder`，三条直连通道的可用性语义不一致。**（本人核实）
函数体只 `if (channel === 'qwenwork')` / `if (channel === 'traework')`，其余落到 `return { ok: true }`。所以 Qoder 无账号时，`/v1/chat/completions` 不会像另两条那样回 503 `channel unavailable`，而是继续进 `handleDirectChannel`，由 `qoder/index.js` 的 `send` 抛错（末次错误码或 502）。`/health` 的 `channels.qoder.ready` 是准确的，但请求路径上的预检缺失。

### P2 —— 行为与文档口径不符

**4. TRAE 没有多账号轮转。**（本人核实）
`traework/index.js` 的 `pickAccount` 是 `const a = list[0]`，注释自述「单账号阶段直接取第一个；多账号轮转后续接 web-pool 的思路」；`auth.findUsable` 也不按 `lastError` 过滤，`send` 没有失败换号。但 `server.js` 的 `onAccount` 注释、`upstream-account.js` 的说明、CLAUDE.md 都按「TRAE 是多账号池 + 轮询/故障转移」表述。单账号被限流或额度耗尽时整条通道持续失败。另外 `models.fetchModels`、管理端 `/traework/checkin`、`task-scheduler` 的自动签到都直接取原始记录、**不走 `needsRefresh`**，token 过期时这几条路径直接 401。

**5. TRAE `normalizeToolCall` 把 `index` 硬默认成 0，使 `aggregate` 的兜底成死代码。**（本人核实）
`normalizeToolCall` 返回 `index: tc.index != null ? tc.index : 0`（恒非 null），而 `aggregate` 写 `const i = nc.index != null ? nc.index : calls.size`——`calls.size` 永不生效。上游若在同一帧发多个不带 `index` 的工具调用，会全部并入 index 0，`arguments` 被拼成一段非法 JSON。当前上游实测帧是带 `index` 的，所以是**潜伏缺陷**而非现网故障。

**6. TRAE 未落地 `lastError` 的三条不变量。**（子代理核读，抽查一致）
`traework/auth.js` 的 `patch` 只 `Object.assign`，不维护 `lastErrorAt`；`index.send` 请求成功不清 `lastError`；前端 `TraeworkAccounts.vue` 直接渲染 `a.lastError`，不调 `lastErrorFresh`。搭子（`accounts.js` 的 `patchInternal` + `utils/lastError.ts`）与千问（`auth.patch` 写 `lastErrorAt`）都做了，TRAE 缺——同一账号可能在界面上长期挂着一次早已自愈的旧错误。

**7. `handleDirectChannel` 残留无用表达式。**（本人核实）
非流式分支里 `const out = kind === 'openai' ? result : result;` 两个分支取值相同，是重构残留。

### 文档漂移

**8. `ARCHITECTURE.md` 与当前实现严重脱节。**（本人核实）它写着 `server.js` 485 行（实际 1537）、`FLOOR` 默认 32768（实际 65536）、模块表只有 7 个文件（没有 qwenwork / traework / qoder / admin / web / 四条通道）、「零第三方依赖」（管理端依赖 `playwright-core`）。作为架构文档继续被引用会持续误导。

**9. 「`anthropic.js` 含 SSE 状态机」的说法不准。**（本人核实）`anthropic.js` 只有 `anthropicToOpenAI` / `openAIToAnthropic` / `mapFinishReason`；Anthropic 的 SSE 状态机 `translateStreamToAnthropic` 在 `server.js`。CLAUDE.md 与 README 都按前者描述。

**10. 快照文件数三处不一致。**（本人核实）README 说 stable 是「36 个 `.js`」，`SNAPSHOT_FROM.txt` 说「43 个 `.js`」，实际 `stable/src` 是 43 个 `.js` + `wasm_helper.mjs`（共 44 个文件）。README 的数字是旧的。

**11. `stable/` 快照落后工作区两个文件。**（本人核实）逐文件 hash 比对：`traework/chat.js`、`traework/index.js` 与 `src/` 不同——即未提交的 TRAE 执行纪律注入与 `token_usage` / `done` 补帧**还没进快照**。快照的其余 42 个文件与 `src` 逐字节一致，且无多余文件。同时 `git status` 显示这两个文件 + `CLAUDE.md` 有未提交改动，`test/verify-traework-toolshape.js` 未纳入版本控制。

**12. 前端 dev 代理指向已停用的 9081。**（本人核实）`web/vite.config.ts` 的 `server.proxy['/api'].target` 是 `http://127.0.0.1:9081`，而 9081 管理端已停用（日常是 9083）。`cd web && npm run dev` 时 `/api` 请求打不通。

### 数据与实现细节

**13. `data/qwenwork-daypeak.json` 的顶层键混了两种语义。**（本人核实）既有账号 id 桶（`"1"`、`"9001"`…`"9005"`），又有三个**日期**键（`"2026-09-23"`、`"2026-09-24"`、`"2026-09-25"`）——早期未按账号分桶时写入的残留。现在按账号分桶的读取逻辑会把日期当成一个伪账号，峰值推断多出一桶。

**14. `stores/channel.ts` 的四个通道 `menuKeys` 完全相同**（都是 9 项），而注释说「与其让用户点进去看到一片空，不如直接隐藏」。菜单隐藏机制形同虚设（实际靠各页面内 `isTw` / `isQw` / `isQd` 分支兜住）。

**15. 管理端若干问题（子代理核读，我抽查了 1 与 4 的代码位置）：** `resetAdminPassword` 在 `server.listen` 之前执行（端口被占时报 EADDRINUSE，但口令已改完，运维会误判「没生效」）；`GET /web-accounts/pool` 的 `req.on('timeout')` 只 `destroy()` 不回包（同文件 `/dashboard` 同场景正常回包，口径不一致）；审计 `actor` 多处硬编码 `'admin'`，且 `qwenwork` / `traework` / `qoder` / `chatlab` 的写操作（含**消耗真实积分的试调**）完全不写审计；静态资源无鉴权（安全性依赖「只监听 127.0.0.1」）；`chatlab` 的 `sessionStart` Map 无上限无过期，`first_token_ms` 恒 null。

**16. 测试口径的小偏差（子代理实测）：** `verify-channel.js` 名为离线，实际要打上游账单接口且需 `data/` 里有可用网页凭证；`verify-ccswitch.js` 与两个探针**没有任何断言**，只打印；`smoke.js` / 三个端到端脚本把 9080 写死在 `req()` 里。

---

## 五、这个项目做得好的地方（同样值得记录）

- **每条反直觉的取舍都留了实测依据**：预算下限 65536、千问默认 131072、TRAE 的 `usage_summary` 解析、Qoder 的倍率 0.1 档、`cosy.encode` 的 O(n) 改写——注释里都有对照数据，而不是「经验之谈」。
- **失败语义区分得很细**：`incomplete` vs `response.failed`（`reasoning_budget_exhausted`）、`tool_arguments_truncated`、签到差值为 0 / 负数 / 快照缺失三种边界、`lastError` 的「无时间戳 = 陈旧」。
- **诚实边界贯穿全项目**：拿不到的字段一律 `null`（`model-info.js` 的 `source` 标记）、TRAE `total_amount` 缺失返回 null 不补 0、Qoder 明确区分「领取额」与「剩余额」、`pointsDelta` 缺失返回 null 不补 0。
- **离线验证密度高**：13 个纯离线脚本覆盖签名逐字节比对、纪律注入幂等、截断判定、到账差值边界、显示名优先级——改这些地方有回归网。

---

## 六、建议的处理顺序

1. 修 Qoder 账本（问题 1）——功能声称与实现相反，且过期提醒完全没数据源。
2. 给 `handleDirectChannel` 的 OpenAI 路径 `shim.write` 加 `ended` 守卫（问题 2）——与 Responses 路径的既有修法对齐，成本极低。
3. 给 `availability` 补 `qoder` 分支（问题 3）——三行代码，消除通道间行为不一致。
4. 快照同步（问题 11）——`traework/chat.js` + `index.js` 按依赖闭包同步进 `stable/` 并更新 `SNAPSHOT_FROM.txt`。
5. 文档校准（问题 8-10、12）——`ARCHITECTURE.md` 要么重写要么加显著过期声明；README 的文件数与 vite 代理端口改掉。
6. 明确 TRAE 的多账号定位（问题 4、5、6）——要么实现轮转 + `lastError` 不变量，要么把 CLAUDE.md 与代码注释统一改成「单账号」口径。
