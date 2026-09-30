# dumate2api

> 架构与代码详解见 [ARCHITECTURE.md](ARCHITECTURE.md)。

把三个上游的模型能力统一转换成 **OpenAI / Anthropic / Google 兼容 API**，供
Codex CLI、Claude Code、cc-switch 等客户端本地使用：

| 通道 | 上游 | 凭证来源 |
|---|---|---|
| **百度搭子**（DuMate） | 本地 HTTP 上游（客户端自带后端） | 桌面客户端登录态 |
| **千问办公**（QwenWork） | 云端网关，进程内直连 | 自持（OAuth Device Flow 换取） |
| **TRAE Work** | 云端网关，进程内直连 | 自持（OAuth 换取） |

**靠模型名前缀分流**，不猜模型名：

| 调用方传的模型名 | 路由到 |
|---|---|
| `model-text` / `glm-5` 等（无前缀） | 百度搭子 |
| `qwen/pro` / `qwen/flash` | 千问办公 |
| `traework/glm-5.2` | TRAE Work |
| 未知前缀（如 `qwn/pro`） | **400 报错，不静默回落** |

> 用前缀而不是猜名字：两侧模型名会撞车（搭子有 `glm-5`，千问上游也是 GLM 系），
> 猜错了两侧都返回 200，从响应里根本看不出来。未知前缀若静默跑到搭子，
> 会拿到「看起来成功但完全不是想要的结果」，比直接 400 难查得多。

## 快速开始

```bash
git clone <仓库地址> && cd dumate2api
npm start          # 网关，默认 http://127.0.0.1:9080
```

首次运行会自动拉起 DuMate 后端（**不需要打开 DuMate 界面**），看到这行即就绪：

```
✓ DuMate main-server verified on port 8980 (headless, no DuMate GUI needed)
✓ dumate2api listening on http://127.0.0.1:9080
```

自检：`curl http://127.0.0.1:9080/health` 应返回 `"upstream_managed":true`。

```bash
curl http://127.0.0.1:9080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"model-text","messages":[{"role":"user","content":"hello"}]}'
```

## 前置条件

1. **Node.js >= 18**。网关本体**零第三方依赖**，只用内置模块；
   `playwright-core` 仅管理端的浏览器登录器需要。
2. **至少配置一条通道**（三条可同时用，也可只留一条）：

**百度搭子**
   - DuMate 桌面客户端已安装，并且至少登录过一次
   - 下载：https://cloud.baidu.com/doc/Dumate/index.html
   - 用百度账号登录一次即可，之后**不再需要启动客户端界面**
   - 登录态（cookie）保存在 `%APPDATA%\qianfan-desktop-app\auth.json`
   - 若安装目录不是默认位置，设置 `DUMATE_INSTALL_DIR`

**千问办公**（可选，只有要用 `qwen/*` 模型时才需要）
   - 登录一次即可，**之后不依赖官方客户端**（凭证自持，见下文）
   - 需要官方客户端的 wasm 文件（运行时从安装目录读取，**不进仓库**）
   - 若探测不到安装目录，设置 `DUMATE_QWENWORK_INSTALL` 或 `CB_QWENWORK_WASM`
   - 设为 `DUMATE_QWENWORK_AUTOSTART=off` 可完全关闭这条通道

**TRAE Work**（可选，只有要用 `traework/*` 模型时才需要）
   - 独立 OAuth 登录，**不依赖 TRAE 客户端**
   - 设为 `DUMATE_TRAEWORK_AUTOSTART=off` 可完全关闭这条通道

> 三条通道独立降级：任一条不可用时网关仍会监听，`/health` 的
> `channels.*.ready` 会报 false，**不阻断启动**。

## 原理

### 通道一：百度搭子（DuMate）

DuMate 桌面客户端（Electron + Go 后端）内置了一个本地 OpenAI 兼容 API：

```
http://127.0.0.1:<动态端口>/api/qianfanproxy/v1/chat/completions
```

- 端口由 `dumate-main-server.exe` 启动时动态分配（通过 `--port=` 参数）
- 认证使用 `Authorization: Bearer nokey`（走已登录的百度 BCE 会话）
- 支持流式 SSE，响应包含 `reasoning_content`（思维链）

### 通道二：千问办公（QwenWork）

**进程内直连**，不需要任何外部服务。`src/qwenwork/` 调用官方客户端的 wasm
生成请求体，再发到云端网关 `gateway.qwenwork.cn`。

三条硬约束（都是实测踩出来的）：

1. **必须依赖官方 wasm**。请求体必须由 `qoder_auth_wasm_bg.wasm` 生成，
   本地自实现的编码会被服务端拒（`400 Invalid agent chat JSON body`）。
   wasm 文件**不进仓库**——它是客户端二进制资产，运行时从安装目录自动探测
   （取版本号最大的那个，客户端多版本并存）。
2. **不套模型映射**。千问的模型名（`pro`/`flash`）不在搭子别名表里，
   过 `mapModel` 会被兜底成 `model-text`，前缀随之失效。
3. **外层永远 HTTP 200**，真实错误在信封的 `statusCodeValue` 里。且它不发
   `data: [DONE]` 而是用 `event:finish` 收尾——转发时按 OpenAI 规范补发 `[DONE]`，
   否则 Codex 等客户端认为响应未完成。

**凭证自持**：早期版本只读官方客户端的 `auth-v2.dat`（Electron safeStorage 加密），
同一时刻只有一份登录态。现在走客户端自己的 OAuth Device Flow（PKCE），
**可多账号并存、可增删、可指定主账号**，换账号不需要打开千问客户端。

**积分是三个独立的池**：`daily`（每日免费额度，每天 00:00 +08:00 重置）、
`monthly`（订阅套餐）、`longterm`（充值赠送）。三池**不能相加**，
与搭子的积分也**互不相干**。真实消耗在管理端「积分明细 / 请求日志」里按条查看。

> 「每日上限」接口不返回，由「观测峰值 + 配置兜底」推断
> （`DUMATE_QWENWORK_DAILY_CREDITS`），界面会标出来源是 `observed` 还是
> `config-lower-bound`。

### 通道三：TRAE Work

同样是**进程内直连**，凭证由本项目自己走 OAuth 换取（`src/traework/login.js`），
不依赖 TRAE 客户端。单一 credits 体系（签到领取），额度按 `usage_summary` 解析。

### 数据流

```
Codex CLI ──── OpenAI/Responses ─┐
                                 ├──→ dumate2api :9080 ──┬──→ DuMate main-server :8980 ──→ 百度千帆
Claude Code ─── Anthropic ───────┤                       ├──→ 千问办公云端网关（进程内直连）
任意客户端 ──── Google ──────────┘                       └──→ TRAE Work 云端网关（进程内直连）
```

## 使用

### 启动 / 停止 / 重启

```bash
node src/server.js        # 直接运行
start.bat                 # 双击（Windows）
stop.bat                  # 停止（不动 DuMate 客户端与 cc-switch，可重复执行）
restart.bat               # 重启

DUMATE2API_PORT=9080 node src/server.js   # 自定义端口
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DUMATE2API_PORT` | `9080` | 网关监听端口 |
| `DUMATE2API_HOST` | `127.0.0.1` | 网关监听地址 |
| `DUMATE_REQUIRE_KEY` | 未设置 | 设为 `1` 才校验 API Key。**默认关闭**：不设置时任何来源无需 key 即可调用 |
| `DUMATE_INSTALL_DIR` | DuMate 默认安装路径 | DuMate 安装目录 |
| `DUMATE_UPSTREAM_PORT` | `8980` | 自建后端监听端口 |
| `DUMATE_AUTOSTART` | `auto` | `auto`=无实例时才拉起；`always`=总是自己拉起；`off`=只用已有实例 |
| `DUMATE_UPSTREAM_LOG` | - | 设为 `1` 时把后端日志打到 stdout |
| `DUMATE_MIN_MAX_TOKENS` | `65536` | 输出预算下限，防止思维链吃光正文（`0` 关闭该策略） |
| `DUMATE_MAX_MAX_TOKENS` | `131072` | 输出预算上限 |
| `DUMATE_ADMIN_PORT` | `9081` | 管理端监听端口 |
| `DUMATE_ADMIN_HOST` | `127.0.0.1` | 管理端监听地址 |
| `DUMATE_ADMIN_DATA` | `./data` | 数据目录（账号、key、请求日志） |
| `DUMATE_ADMIN_GATEWAY_PORT` | `9080` | 管理端去读哪个网关的状态；开发实例应设为 `9082` |
| `DUMATE_QWENWORK_AUTOSTART` | `auto` | `auto`=启用千问通道 / `off`=关闭 |
| `DUMATE_QWENWORK_INSTALL` | 自动探测 | 千问办公安装根（wasm 探测失败时手动指定） |
| `CB_QWENWORK_WASM` | 自动探测 | 直接指定 `qoder_auth_wasm_bg.wasm` 的完整路径 |
| `DUMATE_QWENWORK_DAILY_CREDITS` | `100` | 千问每日免费额度的配置兜底下限 |
| `DUMATE_QWENWORK_MIN_MAX_TOKENS` | `16384` | 千问输出预算下限 |
| `DUMATE_QWENWORK_DEFAULT_MAX_TOKENS` | `131072` | 千问默认输出预算（客户端未给 `max_tokens` 时） |
| `DUMATE_TRAEWORK_AUTOSTART` | `auto` | `auto`=启用 TRAE 通道 / `off`=关闭 |
| `DUMATE_TRAEWORK_MIN_MAX_TOKENS` | `16384` | TRAE 输出预算下限 |
| `DUMATE_WEB_FALLBACK` | 未设置（开启） | 设 `0` 关闭「桌面凭证不可用时回落到网页凭证池」 |

> 完整列表见 [CLAUDE.md](CLAUDE.md)（含网页账号池、任务轮询、自动签到等）。

> `DUMATE2API_KEY` 在早期版本里被文档描述为「代理 API Key」，但代码中从未读取它，
> 设置它并不会带来任何鉴权效果。真实开关是 `DUMATE_REQUIRE_KEY`，配套的 key
> 在管理端「API Key」页创建。

### 管理端（可选但推荐）

另起一个终端：

```bash
npm run admin          # 默认 http://127.0.0.1:9081
```

首次启动会生成管理员口令并打印在终端。**改的是哪个网关端口就要带对应变量**，
否则管理端会读到别的实例的数据：

```bash
DUMATE_ADMIN_GATEWAY_PORT=9082 npm run admin
```

管理端提供：仪表盘、模型管理、API Key、登录态、积分明细、账号管理、
用量统计、请求日志、聊天测试台。

**通道切换**：顶栏可在「百度搭子 / 千问办公 / TRAE Work」间切换，各页面据此
显示对应通道的数据。三条通道的账**各自独立**——搭子靠上游账单 + 余额游标，
千问是三个积分池，TRAE 是每账号独立的 credits，**三边数字不能相加**。

开发时用 `start-dev.bat`（网关 9082 + 管理端 9083），与稳定版 9080 互不干扰。
前端开发：`cd web && npm install && npm run dev`。

### 使用千问办公 / TRAE 通道

模型名加前缀即可，无需额外配置：

```bash
# 千问办公
curl http://127.0.0.1:9080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen/pro","messages":[{"role":"user","content":"hello"}]}'

# TRAE Work
curl http://127.0.0.1:9080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"traework/glm-5.2","messages":[{"role":"user","content":"hello"}]}'
```

可用模型由上游下发，清单见 `GET /v1/models` 或管理端「模型管理」页。

## cc-switch 配置教程

### 第 0 步：先把网关跑起来

```bash
cd <你克隆仓库的目录>
npm start
```

自检：`curl http://127.0.0.1:9080/health` 应返回 `"upstream_managed":true`。

### 第 1 步：添加 Claude 供应商

打开 cc-switch → **Claude** 标签 → 添加供应商：

| 字段 | 值 |
|------|-----|
| 名称 | `DuMate 搭子 API (Claude)` |
| API 格式 | `anthropic` |
| Base URL | `http://127.0.0.1:9080`  ← **不要加 `/v1`** |
| API Key | `nokey` |
| 模型 | `model-text`（条目内可切 `model-artifact-validate`） |

完整 env（点「高级/编辑 JSON」时可直接粘贴）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9080",
    "ANTHROPIC_AUTH_TOKEN": "nokey",
    "ANTHROPIC_API_KEY": "nokey",
    "ANTHROPIC_MODEL": "model-text",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "model-text",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "model-text",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "model-text"
  }
}
```

> 必须把 haiku / sonnet / opus 全部设为 `model-text`。否则 Claude Code 切换模型
> 档位时会发来 `claude-haiku-4-5` 之类的名字，虽然会被兜底映射，但显式写死更稳。

### 第 2 步：添加 Codex 供应商

打开 cc-switch → **Codex** 标签 → 添加供应商：

| 字段 | 值 |
|------|-----|
| 名称 | `DuMate 搭子 API (Codex)` |
| API 格式 | `openai_responses`（网关侧翻译成 chat/completions 后再转发上游） |
| Base URL | `http://127.0.0.1:9080/v1`  ← **要加 `/v1`** |
| API Key | `nokey` |
| 模型 | `model-text` |

`config.toml` 内容：

```toml
model_provider = "dumate"
model = "model-text"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.dumate]
name = "DuMate local proxy"
base_url = "http://127.0.0.1:9080/v1"
wire_api = "responses"
requires_openai_auth = true
```

> **`wire_api = "responses"`。** Codex CLI 0.155+ 已移除 `chat`（配置加载阶段直接报
> `wire_api = "chat" is no longer supported`）。网关自带 `/v1/responses` 适配层，
> 把 Responses 协议翻译成上游的 `chat/completions`，所以这里填 `responses` 即可。

### 为什么 URL 一个有 `/v1` 一个没有

- Claude 协议：cc-switch 会把 `ANTHROPIC_BASE_URL` 拼上 `/v1/messages`；
  网关同时接受 `/v1/messages` 和裸 `/messages`
- Codex 协议：Codex 要求 base_url 本身已含 `/v1`，它会再拼 `/chat/completions`

### 第 3 步：验证

```bash
node test/verify-ccswitch.js
```

会依次实测 Codex 路径、Claude 路径、裸路径兼容性和模型名映射。
四条都返回 200 且正文非空即为成功。

也可以直接在客户端里问一句「用四个字回答：中国的首都是哪里？」，应回「首都北京」。

### 常见坑

| 现象 | 原因 | 解决 |
|------|------|------|
| 连接被拒绝 | 网关没起 | 先 `npm start` |
| `404 Not found: /v1/responses` | 网关版本过旧，没有 Responses 适配层 | 更新到含 `src/responses.js` 的版本后重启 |
| `wire_api = "chat" is no longer supported` | Codex ≥0.155 移除了 chat 协议 | 配置改成 `wire_api = "responses"` |
| 返回内容为空 | max_tokens 太小，被思维链吃光 | 见下方说明 |
| 报未登录 | 百度 cookie 过期 | 打开一次 DuMate 客户端重新登录 |
| 千问报 402 | 千问额度耗尽 | 与代码无关，换账号或等次日重置 |

**关于空返回**：GLM 的思维链和正文共用同一个 `max_tokens` 预算，而 reasoning
长度不可控（实测同一提示词 57 ~ 8492 tokens 都出现过）。预算给得不够时会出现
两种症状：正文全空（`stop_reason=max_tokens`）或**说到一半停住**（reasoning
把预算吃光，正文被截断在句子中间，对客户端看起来就是「能快就停」）。

网关统一把预算抬到 65536 以上（可用 `DUMATE_MIN_MAX_TOKENS` 调整），
让 reasoning 无论怎么展开都还剩得下正文空间。

## 思考强度与上下文：能调到多大

### 先说结论（实测，不是照抄文档）

| 你想调的东西 | 能不能调 | 实际情况 |
|---|---|---|
| 思考强度 | **调不了** | 上游忽略 `reasoning_effort`。实测 low/medium/high/xhigh 的 reasoning token 数为 31/31/19/31 —— 无差异 |
| 关闭思维链 | **关不掉** | GLM 恒定输出 reasoning。系统提示只能压缩（42→29 字符），不能消除 |
| 上下文窗口 | **192K**（硬上限） | DuMate 配置声明值；32K 级输入实测通过（52K 实际 token） |
| 输出长度 | **128K**（硬上限） | 配置声明值；上游对任意 `max_tokens` 都不校验 |

> 既然上游不认 `reasoning_effort`，配置里的 `xhigh` / `effort=max` 不会让模型真的
> 「更用力想」。它们的实际作用是**让客户端给更大的输出预算**，这在共享预算模型下
> 等价于让正文有更多空间。

### 关键机制：思维链和正文抢同一个预算

GLM 的 reasoning 与正文**共用** `max_tokens`。这是最容易踩的坑：

| 客户端传的 max_tokens | 结果 |
|---|---|
| 150 | 推理吃掉全部 150 → 正文 `""`，`stop_reason=max_tokens` |
| 1024 | 推理吃掉全部 1024 → 正文 `""` |
| 4096 | 多数情况可用，但 reasoning 峰值可到 4000+ → 仍会被截断 |
| 65536 | 实测稳定，正文完整返回 |

网关统一把预算抬到 65536 以上（`DUMATE_MIN_MAX_TOKENS` 可调，`0` 关闭）。
所以**输出预算越大，你能拿到的正文越长**——这是唯一真正有效的「调大」手段。

### 两个模型的区别（实测对比）

上游只暴露两个真实模型，不存在「更强档位」。传别的名字会 404：

```
model `model-ultra` does not exist. api not registered.
```

| | `model-text` | `model-artifact-validate` |
|---|---|---|
| 定位 | 通用主力（Qianfan GLM-5） | 产出校验/审阅 |
| 数学推理 | 正确，1.2s | 正确，1.4s |
| 代码能力 | 正确，推理 133 token | 正确，推理 301 token（更啰嗦） |
| 格式遵循 | 精确，398ms | 精确，1022ms |
| 速度 | **更快** | 慢 2-3 倍 |

**两者答案质量一致**，差别只在 `model-artifact-validate` 推理链更长、更慢。

### 怎么在两个模型间切换

cc-switch 里**每个 app 只保留一个条目**，模型在同一条目内切换，不必建两个供应商。

**Claude Code** —— 用 `/model` 命令，档位即模型：

| 档位 | 实际模型 | 特点 |
|---|---|---|
| sonnet（默认） | `model-text` | 快，日常用 |
| haiku | `model-text` | 同上 |
| opus | `model-artifact-validate` | 推理链更长，慢 2-3 倍 |

**Codex CLI** —— 改 `model` 一行即可：

```toml
model = "model-text"                 # 快（默认）
# model = "model-artifact-validate"  # 更仔细，但慢 2-3 倍
```

### 使用场景建议

- **日常编码 / Codex CLI / Claude Code → 用 `model-text`**（默认）。更快，答案无差别。
- **需要模型自我审查产出**（生成文档/代码后要它自己挑错）→ 试
  `model-artifact-validate`，它的定位就是校验，但代价是慢 2-3 倍。
- **长上下文**：192K 窗口适合整仓代码分析。但实测 128K 级单请求耗时超过 10 分钟
  未返回，**建议把单次输入控制在 32K 以内**（约 5 万实际 token），靠 Codex 的自动
  压缩（180000 阈值）分段处理，别指望一次塞满。
- **不要指望调「思考强度」**：这个模型没有该旋钮。想要更详尽的分析，直接在提示词里
  要求「逐步分析」比调参数有效。

## API 端点

| 端点 | 协议 | 说明 |
|------|------|------|
| `GET /v1/models` | OpenAI | 模型列表（三条通道的模型都列出） |
| `POST /v1/chat/completions` | OpenAI | 聊天补全（透传 + 模型映射） |
| `POST /v1/responses` 或 `/responses` | OpenAI Responses | Codex CLI 0.155+ 专用，翻译成 chat/completions |
| `POST /v1/messages` 或 `/messages` 或 `/api/v1/messages` | Anthropic | Messages API（完整翻译） |
| `POST /v1/messages/count_tokens` | Anthropic | Token 计数（估算，Claude Code 会调用） |
| `GET /v1beta/models` | Google | 模型列表（Generative Language） |
| `POST /v1beta/models/{model}:generateContent` | Google | 生成内容（翻译层） |
| `POST /v1beta/models/{model}:streamGenerateContent` | Google | 流式生成（翻译层） |
| `GET /health` / `GET /ping` | - | 健康检查，含三条通道的就绪状态 |

> 裸路径 `/messages` 必须保留：Claude Code 打的是不带 `/v1` 的路径。
> Google 路径的模型名支持带前缀的 `qwen/pro`（正则不排除 `/`）。

> `count_tokens` 使用 `字节数/4` 的保守估算。DuMate 未暴露分词器，该接口仅用于
> 让 Claude Code 的上下文预算计算不报错，非精确值。

## 模型映射

搭子通道（可经管理端「模型管理」页编辑）：

| 请求模型名 | 实际使用 |
|-----------|---------|
| `model-text` | `model-text`（直通） |
| `model-artifact-validate` | `model-artifact-validate`（直通） |
| `glm-5` | `model-text` |
| `claude-3-5-sonnet-*` | `model-text` |
| `gpt-4o` / `gpt-4` / `o1` / `o3` 等 | `model-text` |

未收录的模型名一律回退为 `fallback`（默认 `model-text`）。

千问办公与 TRAE 通道：**不做映射**，模型表由上游下发，只能按前缀名调用。
这两条通道的模型名走 `mapModel` 会被兜底成 `model-text`，前缀随之失效，
所以刻意跳过映射。

## 注意事项

1. **不需要启动 DuMate 界面**：网关会直接拉起其后端 `dumate-main-server.exe`（无 GUI）。
   只有当登录态过期、需要重新登录时，才要打开一次 DuMate 客户端。
2. **账号额度**：搭子用百度搭子账号的模型额度（免费积分）；千问办公与 TRAE Work
   各用自己的积分体系。**三套账互不相通，不要相加**。
3. **端口动态**：DuMate 每次启动端口可能变化，网关会自动重新发现
   （每 30s 或在发现失败时重试）。
4. **思维链**：搭子返回 `reasoning_content`，Anthropic 端点会翻译为 `thinking` block。
5. **Token 用量**：流式 Anthropic 请求会带上 `stream_options.include_usage`，
   在结尾的 `message_delta` 中返回真实 `input_tokens` / `output_tokens`；
   上游若不支持则该值为 0。
6. **千问的 wasm 不进仓库**：它是官方客户端的二进制资产，运行时从安装目录读取。
7. **仅 Windows**：依赖 PowerShell（进程查询）、`%APPDATA%` 路径、`taskkill`。

## 快速测试

```bash
# OpenAI 格式
curl http://127.0.0.1:9080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer nokey" \
  -d '{"model":"model-text","messages":[{"role":"user","content":"hello"}]}'

# Anthropic 格式
curl http://127.0.0.1:9080/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: nokey" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":100,"messages":[{"role":"user","content":"hello"}]}'

# 千问办公（前缀路由）
curl http://127.0.0.1:9080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen/pro","messages":[{"role":"user","content":"hello"}]}'
```

## 无 GUI 运行原理

DuMate 的 Go 后端 `dumate-main-server.exe` 本来由 Electron 通过 IPC 注入登录态。
单独启动会报 `loginMode is required`。逆向二进制后发现它可以从环境变量读取登录上下文：

```
DUMATE_LOGIN_MODE=standalone
DUMATE_LOGIN_USER_ID=<bceUserId>
DUMATE_LOGIN_USER_NAME=<displayName>
DUMATE_LOGIN_BCE_ACCOUNT_ID=<bceAccountId>
```

`src/upstream-launcher.js` 会自动从 `%APPDATA%\qianfan-desktop-app\auth.json` 读出
当前活跃账号（`activeProfileId`）并注入这些变量，然后 spawn 后端：

```bash
dumate-main-server.exe -c "<install>\resources\config\desktop-main\config.yml" -port 8980
```

真正的凭证（cookie）仍然来自磁盘上已保存的登录态，本项目不接触也不复制它们。
**cookie 过期后必须打开一次 DuMate 客户端重新登录**，之后又可继续无 GUI 使用。

## 测试

```bash
# 冒烟测试（32 项断言，需要网关在线）
npm test

# 端到端：Codex / Claude / 裸路径 / 模型映射四条链路
node test/verify-ccswitch.js

# 单点探针：只打一种协议，把原始 SSE 打到 stdout
node test/probe-oai.js       # OpenAI 格式
node test/probe-anth.js      # Anthropic 格式（含 x-api-key / anthropic-version）
```

**离线验证**（不需要起服务，改完相关代码先跑这些）：

```bash
node test/verify-channel.js             # 通道过滤 + 积分归因配对（13 项）
node test/verify-qwen-discipline.js     # 千问「执行纪律」注入条件与幂等
node test/verify-truncated-toolcall.js  # 工具参数截断判定
node test/verify-traework-gained.js     # TRAE 签到到账差值（含 0/负数边界）
node test/verify-display-name.js        # 账号显示名解析（占位名识别、优先级）
node test/verify-qwen-daily-aggregate.js # 千问每日额度多账号合计口径
node test/verify-qwen-wallets-zero.js   # 千问「三池全 0」可疑响应的重试判据
```

**离线自测完整流程**（无需安装 DuMate）：

```bash
# 终端 1：启动 mock 上游（监听 52890）
npm run mock
# 终端 2：启动网关
npm start
# 终端 3：跑冒烟测试
npm test
```

`test/smoke.js` 覆盖：模型列表、OpenAI 流式/非流式、Anthropic 流式/非流式、
思维链转 `thinking`、token 用量、多轮对话、system/tool_use/tool_result 转换、
`count_tokens`、错误路径与 404。

## 逆向分析要点

- **应用类型**：Electron（`app.asar` 87MB）+ Go 后端（`dumate-main-server.exe` 61MB）
- **关键配置**：`resources/config/opencode/opencode.json` 暴露了内部 API 结构
- **端口发现**：`dumate-main-server.exe --port=<动态>` 命令行参数
- **认证**：`Bearer nokey`（服务本身不做 key 校验，依赖 DuMate 登录态）
- **模型**：`model-text`（Qianfan GLM-5，192K 上下文 / 128K 输出）

## 许可证

[MIT](LICENSE)

## 免责声明

本项目通过逆向与协议适配实现本地互操作，**仅供个人学习与研究使用**。
请遵守各上游服务的使用条款。使用者需自行承担因使用本项目产生的任何后果。
