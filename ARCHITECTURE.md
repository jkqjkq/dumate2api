# dumate2api 架构总览

> 本文是架构的**当前事实快照**（2026-10 对齐施工后重写；旧版停在单上游时代）。
> 每个模块的"为什么存在"以源文件头注释为权威——本项目纪律是**why 写在代码头部**，
> 本文只负责模块边界、数据流与全局图。运行手册见 `README.md` 与 `CLAUDE.md`，
> 测试怎么跑见 `test/README.md`，历史审计记录见 `CODE_REVIEW.md`。

## 1. 这个项目是什么

dumate2api 是一个 **Node ≥18 零依赖**的 API 网关：把四个上游（百度搭子 DuMate、
千问办公、TRAE Work、Qoder）统一翻译成 OpenAI / Anthropic / Google 兼容协议，
供 Codex CLI、Claude Code、cc-switch 等客户端使用，并内嵌一个管理端（登录、
签到、积分、模型映射、聊天试调）。

唯一的生产依赖是 `playwright-core`（仅管理端登录助手用）；`src/` 网关本体
**零第三方模块**——所有能力用 Node 内置模块实现（http/fs/crypto/
worker_threads/node:test）。加能力的默认姿势是"用内置模块写一个小模块"，
不是装包。

## 2. 进程拓扑

```
客户端（Codex / Claude Code / cc-switch）
   │ OpenAI / Anthropic / Google 协议
   ▼
src/server.js（:9080，网关进程）
   │  鉴权(keys.js) → CORS(cors.js) → 协议翻译(anthropic/google/responses.js)
   │  → 预算(budget.js) → 选号(upstream-router.js + pool.js)
   ▼
四个出口
   ├─ 搭子：discovery.js 找到 DuMate 后端端口（upstream-launcher.js 可无 GUI 拉起）
   │        → web-pool.js（网页 cookie 池 + 转发）
   ├─ qwenwork / qoder：COSY 协议直连（cosy.js 签名 + offthread.js worker）
   ├─ traework：自有协议直连
   └─ 全部出口可经 proxy-agent.js 注入 per-account 出站代理
   │
   ├──埋点──> reqlog.js（requests.jsonl，32MB 轮转）
   │            └→ reqlog-hook.feed → usage-agg.js（分桶留存）→ balance-hist.js（余额流水）

src/admin/server.js（管理端进程，独立端口）
   └─ admin/routes/*（17 文件 ~120 路由）→ 复用 src/ 同一批模块（跨进程靠
      data/*.json 的 mtime 失效重读 + filelock.js 互斥同步）

test/mock-upstream.js（开发辅助：假 DuMate 上游，`npm run mock`）
```

三个常驻进程（网关 / 管理端 / web 网关 web-gateway.js）**共享 `data/` 下的
JSON 与 JSONL 文件**，这是理解全部同步纪律的钥匙：进程内读-改-写是同步代码
天然串行，跨进程只有 mtime 失效重读 + filelock 两件武器。

## 3. 模块地图（`src/`，按层）

### 3.1 协议入口与翻译（网关进程）

| 模块 | 职责 |
|---|---|
| `server.js` | HTTP 入口、路由分发、请求体上限（413）、事件循环卡顿探针。**所有施工包都不直接改它**——扩展点在 reqlog / 通道模块内 |
| `anthropic.js` / `google.js` / `responses.js` | 三套协议 ↔ OpenAI 的双向翻译（含流式） |
| `budget.js` | 输出预算钳制（搭子 65536 / 直连 16384 下限，各通道不互套） |
| `modelmap.js` / `channels.js` / `keys.js` | 模型映射、通道白名单、API key 的单一来源；mtime 热读 |

### 3.2 路由与选号

| 模块 | 职责 |
|---|---|
| `upstream-router.js` | 模型名前缀 → 通道解析 + availability 三通道预检（语义一致） |
| `pool.js` | **账号池惩罚-恢复状态机**（GAP F1/包 A）：多类冷却（429 软冷却 / 5xx 熔断退避 / 模型负缓存）、sessionDead 连续计数防误杀、余额保底拦截、freeze/revive API、`data/pool-state.json` 持久化（filelock + tmp+rename，5s 防抖）；重启择新恢复 |
| `sticky.js` | 会话粘性（哈希→uid，LRU+TTL），保底拦截时解绑换号 |
| `web-pool.js` | 搭子网页 cookie 池（旧的内存冷却已接 pool.js 状态机） |

### 3.3 通道包（`qwenwork/`、`traework/`、`qoder/`）

每个通道包自成一体：`constants.js`（协议常量）、`auth.js`（凭证读写 + 刷新）、
`login.js`（设备流 / 授权链接）、`chat.js`（对话）、`credits.js`（积分）、
`session.js` / `checkin.js` 等按需。约定：**凭据读写收口在通道包的
authStore**，管理端路由只调它；`qoder/` 同时是 per-channel store 模式的
底本（`templates/channel-skel/` 提炼自它）。

COSY 协议栈被 qwenwork 与 qoder 共用：签名算法只在 `cosy.js` 一份
（RSA 包 tempKey + AES 身份 + md5 请求签名，key 必须字母序、AES 必须关
Node 自动补位——两个实测坑都写在头注释）。

### 3.4 调度与联动

| 模块 | 职责 |
|---|---|
| `task-scheduler.js` | 任务轮询（30min ± 抖动，风控纪律：错峰、抖动、跳过禁用号） |
| `keepalive.js` | **凭证保活与余额联动**（GAP F2/包 B）：每日低峰轮跑 refresh→查余额；余额>0 的冷却账号自动 `pool.revive`（签到→查余额→解冻闭环） |
| `admin/routes/autotask.js` | 每日自动签到排程（幂等、可配时刻） |

### 3.5 计量与账本

| 模块 | 职责 |
|---|---|
| `reqlog.js` | 请求明细 `data/requests.jsonl`（32MB 轮转）；首字耗时统计；`reqlog-hook.feed` 是 usage-agg 的挂接点（不经 server.js） |
| `usage-agg.js` | **长期用量分桶**（GAP F3/包 C）：按 (时间片，通道，账号，模型，费率) 累加，小时桶 7 天后折叠日桶永久留存，`data/usage-agg.json` 原子落盘 |
| `balance-hist.js` | **余额变动流水**（GAP F4/包 C）：余额快照逐次比对，带符号 Delta 追加 `data/balance-hist.jsonl`，首见建基线 |
| `points-agg.js` / `points-cursor.js` / `records.js` / `checkin-ledger.js` | 额度包聚合视图 / 消耗归因游标 / 操作流水 / 签到账本 |
| `upstream-account.js` | 账号归因（provider 主动上报 `req._upstreamAccount`，比日志反推可靠） |

### 3.6 横切基础设施（今天安全审计修复的主体）

| 模块 | 职责与边界 |
|---|---|
| `filelock.js` | **跨进程文件锁**（P1-2）：`<target>.lock` O_EXCL 独占创建，死进程/超龄锁允许拆，同步等待（Atomics.wait）。所有共享 JSON 的读-改-写都必须在 `withLock` 内，且 fn 第一行置模块缓存失效 |
| `jsonl.js` | **带大小轮转的 JSONL 追加**（P1-4）：超 16MB 归档 `.old` 保留一代。匿名可达的埋点文件（积分游标/审计）统一走它，堵"慢性磁盘放大器" |
| `fileperm.js` | **凭证文件权限收紧**（P1-3）：POSIX chmod 0600；Windows 用 icacls 收紧数据目录（先授予后断继承），尽力而为、失败静默 |
| `cors.js` | **CORS fail-closed**（P0-1）：默认不发任何 CORS 头；白名单 `DUMATE_CORS_ORIGINS` 命中才回显 Origin；配置出现字面 `*` 按配置错误处理，绝不退化回全开 |
| `offthread.js` | **同步热点挪 worker**（P1-5）：登录 scrypt / cosy 编码在常驻 worker 串行执行，事件循环不被占；worker 起不来或崩溃回退同步版。worker 空闲 3s 自杀（Node 24 实测 unref 不再让主进程退出），下个任务懒重建 |
| `livecfg.js` | **热配置快照**（GAP F5/包 D）：模块单例持不可变快照，Store 整体替换 / Load 返回拷贝；跨进程 mtime 失效重读；字段白名单（软冷却基数 / 脱敏开关 / 隐藏模型等） |
| `errtext.js` / `upstream-errors.js` | 错误串人话翻译（写入与读取两层、不套娃、保留原串）；COSY 上游错误形状识别（单一来源，error 对象先于 type 判） |
| `proxy-agent.js` | **per-account 出站代理**（GAP F8/包 E）：零依赖 HTTPS-over-CONNECT 隧道 agent + 工厂，账号 `proxy` 字段注入各通道出口 |
| `scrypt-task.js` / `discovery.js` / `upstream-launcher.js` | 登录 scrypt 限流与 worker 化（P1-5） / 端口三级发现 / 无 GUI 拉起后端 |

### 3.7 管理端与前端

- `admin/server.js` + `admin/auth.js`：会话（scrypt + 按 IP 限流 + 锁定）、
  `audit()` 把敏感动作追加 `data/admin-audit.jsonl`（签到、登录落凭据、
  删号/改号、chatlab 试调、cc-switch 应用——**消耗积分与改凭据的动作全部过审计**）。
- `admin/routes/*`：17 个路由文件，`mount(prefix, table)` 声明式注册。
- `web/`：Vue 单页（管理端前端）；`web-gateway.js` 是外部客户端的正式
  入口网关（带密钥鉴权，:9084）。

## 4. 一次请求的生命周期（数据流）

1. **入口**：`server.js` 收请求 → `cors.headersFor` 挂 CORS 头（默认零头）
   → `keys.js` 鉴权（`DUMATE_REQUIRE_KEY=1` 或设置了 `DUMATE2API_KEY` 时强制）
   → 请求体字节上限。
2. **翻译**：按协议（Anthropic / OpenAI / Responses / Google）调对应翻译层，
   `budget.resolve*MaxTokens` 钳输出预算。
3. **选号**：`upstream-router.resolve` 按模型前缀定通道 → `pool.js` 过滤
   惩罚态（冷却/熔断/保底拦截/sessionDead）→ 通道包取可用账号 →
   `proxy-agent` 按账号注入出口 agent。
4. **出口**：搭子走 `web-pool` 转发 DuMate 后端；直连通道走各自 `chat.js`
   （COSY 通道经 `offthread.run(cosy.encode)` 签名，worker 里算）。
5. **埋点**：`reqlog.record` 写明细 → 钩子喂 `usage-agg` 分桶；余额快照
   走 `points-cursor` / `balance-hist`；失败按错误类别回写 `pool.js`
   （429 软冷却、5xx 熔断计数、模型负缓存）。
6. **回程**：流式 SSE 透传 / 翻译回目标协议；首字耗时由 `reqlog.markFirstToken` 统一记。

**管理端动作**（签到 / 登录 / 删号 / chatlab / 配置热改）与网关共享同一批
`data/` 文件：写侧 `filelock.withLock` + tmp+rename，读侧 mtime 失效重读，
敏感动作尾部 `auth.audit()` 留痕。

## 5. 测试基座

`npm test` = `node --test "test/*.test.js" "test/unit/*.test.js"`（**必须用
glob 形态**——显式目录形态会把 smoke/verify 探针一起执行；`test/unit/`
是后补进 glob 的，D 包 23+ 例曾因漏接线从未被跑过）。约定与夹具见
`test/README.md`：

- `test/<模块>.test.js`：离线单测（node:test + assert/strict），新模块随包 TDD；
- `test/helpers/`：`tmpdata`（临时 data 目录 + 模块重载——env 在 require 时
  固化的模块必须"先设 env 再 reload"）、`http-mock`（一次性假上游）；
- `test/smoke.js`（`npm run test:smoke`）与 `verify-*` / `probe-*`：真机门禁，
  需活网关、耗真实积分，**不属自动化门禁**；
- 存量模块已覆盖：cors / filelock / jsonl / fileperm / offthread（安全修复
  五件套）+ points-agg / errtext / upstream-errors / cosy / model-info；
  新模块随包同交付：pool / sticky / keepalive / usage-agg / balance-hist /
  reqlog-hook / livecfg / qoder-grants / upstream-router / proxy-agent，
  另有 test/integration.test.js 集成验收（启动链 / 选号状态机 / 代理挂接
  端到端）。

## 6. 文档地图

| 文档 | 内容 |
|---|---|
| `README.md` | 面向使用者的运行说明 |
| `CLAUDE.md` | 给编码 agent 的全景手册（命令 / 约定与陷阱 / 环境变量 / 数据文件），97KB 单体，按「网关 / 通道包 / 管理端 / 前端」拆章是已排期的 D3 建议 |
| 本文 | 架构边界与数据流快照 |
| `test/README.md` | 测试约定 |
| `CODE_REVIEW.md` / `QODER_HANDOFF.md` | 历史审计与通道交接记录 |

模块的深层"为什么"（实测数字、事故复盘）一律以**源文件头注释**为权威——
本文与其冲突时，以代码头注释为准。
