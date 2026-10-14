# dumate2api

![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

**百度搭子（DuMate）本地网关** —— 把百度搭子、千问办公、TRAE Work、Qoder 四条上游统一转成 **OpenAI / Anthropic / Google 兼容 API**，给 Codex CLI、Claude Code、cc-switch 用；无 GUI 拉起搭子后端，自带网页管理端。完整使用说明（安装配置 / 管理端逐页指南 / FAQ 排查）见 **[用户使用手册](docs/USER_MANUAL.md)**。

<p align="center">
  <img src="assets/screenshots/dashboard.png" alt="管理端仪表盘" width="860" />
</p>

```
Codex CLI ──── OpenAI / Responses ─┐
Claude Code ──── Anthropic ────────┼──→ dumate2api :9080 ──┬──→ DuMate 后端 :8980 ──→ 百度千帆
任意客户端 ──── Google ────────────┘                        ├──→ 千问办公（进程内直连）
                                                            ├──→ TRAE Work（进程内直连）
                                                            └──→ Qoder（进程内直连）
```

## 特性

- **三协议网关** —— OpenAI / Anthropic（含原生工具）/ Google，外加 Responses 适配层（Codex CLI 0.155+ 只认它）
- **四通道前缀分流** —— 靠模型名前缀显式路由，未知前缀直接 400，不静默回落
- **凭证自持，零客户端依赖** —— 千问 / TRAE / Qoder 三条通道 OAuth 自取凭证、签名纯本地算法，**不需要装任何官方客户端**；搭子也能只用网页凭证（`DUMATE_DUMATE_SOURCE=web`）
- **零第三方依赖** —— 网关本体只用 Node 内置模块
- **网页控制台** —— 仪表盘、模型管理、积分明细、用量统计、请求日志、聊天测试台
- **积分自动化** —— 签到幂等可定时；抽奖消耗不可逆，只留手动

## 快速开始

```bash
git clone <repo-url> && cd dumate2api
npm start                  # 网关 http://127.0.0.1:9080
npm run admin              # 管理端 http://127.0.0.1:9081（另开终端）
```

首次运行会自动拉起 DuMate 后端（**不需要打开 DuMate 界面**）。自检：

```bash
curl http://127.0.0.1:9080/health     # 应返回 "upstream_managed":true

curl http://127.0.0.1:9080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"model-text","messages":[{"role":"user","content":"hello"}]}'
```

## 四条通道

| 通道 | 上游 | 凭证 | 需要官方客户端 |
|---|---|---|---|
| **百度搭子**（DuMate） | 本地 :8980（千帆 GLM） | 桌面登录态 / 网页 cookie | 默认是；`DUMATE_DUMATE_SOURCE=web` 后可**完全不用** |
| **千问办公**（QwenWork） | 云端网关，进程内直连 | 自持（OAuth Device Flow） | **否**（签名纯本地） |
| **TRAE Work** | 云端网关，进程内直连 | 自持（OAuth） | 否 |
| **Qoder** | 云端网关，进程内直连 | 自持（OAuth Device Flow） | **否**（签名纯本地） |

**靠模型名前缀分流**，不猜模型名（两侧模型名会撞车，猜错了两侧都返回 200，从响应里看不出来）：

| 调用方传的模型名 | 路由到 |
|---|---|
| `model-text` / `glm-5` 等（无前缀） | 百度搭子 |
| `qwen/pro` / `qwen/flash` | 千问办公 |
| `traework/glm-5.2` | TRAE Work |
| `qoder/gfmodel` | Qoder |
| 未知前缀（如 `qwn/pro`） | **400 报错，不静默回落** |

> 千问办公与 Qoder 是**同一套 COSY 协议**（同一个 `client_id`、同一把服务端公钥），共用 `src/cosy.js` 一份纯本地签名实现，都不需要官方 wasm。千问做重创作用 `pro`（`flash` 会播报进度就收尾）；Qoder 零额度时聊天会挂起，**签到是通道可用的前提**，且倍率差 14 倍、调试用 0.1 档（`gfmodel` 等）。通道细节与实测数据见 [CLAUDE.md](CLAUDE.md)。

**搭子有两条凭证链路，能力一致**：桌面凭证（需装客户端）与网页凭证（浏览器 cookie）。桌面凭证不可用时**自动回落到网页池**，四条协议（含 `responses`）在回落路径上都实测可用；想彻底不要客户端就设 `DUMATE_DUMATE_SOURCE=web`。

## 客户端配置

| 标签 | API 格式 | Base URL | Key | 模型 |
|---|---|---|---|---|
| Claude | `anthropic` | `http://127.0.0.1:9080` ← 不加 `/v1` | `nokey` | `model-text` |
| Codex | `openai_responses` | `http://127.0.0.1:9080/v1` ← 要加 `/v1` | `nokey` | `model-text` |

Codex 的 `config.toml`：

```toml
model_provider = "dumate"

[model_providers.dumate]
name = "DuMate local proxy"
base_url = "http://127.0.0.1:9080/v1"
wire_api = "responses"          # 0.155+ 只认 responses
requires_openai_auth = true
```

| 端点 | 协议 |
|------|------|
| `POST /v1/chat/completions` | 聊天补全 |
| `POST /v1/responses` 或 `/responses` | Responses（Codex CLI） |
| `POST /v1/messages` 或 `/messages` | Anthropic Messages |
| `GET /v1beta/models` / `POST .../generateContent` | Google Generative Language |
| `GET /v1/models` / `GET /health` | 模型列表 / 健康检查 |

## 管理端

```bash
DUMATE_ADMIN_GATEWAY_PORT=9082 npm run admin   # 开发实例要带这个变量
```

首次启动生成管理员口令并打印在终端。顶栏切换通道，各页面据此显示对应数据。

<p align="center">
  <img src="assets/screenshots/models.png" alt="模型管理" width="420" />
  <img src="assets/screenshots/usage.png" alt="用量统计" width="420" />
  <img src="assets/screenshots/points.png" alt="积分明细" width="420" />
  &nbsp;
</p>

| 页面 | 回答什么问题 |
|---|---|
| 仪表盘 | 各通道健康、用量、账号状态、即将过期积分 |
| 模型管理 | 有哪些模型、上下文/输出上限、倍率、额度还剩多少 |
| 积分明细 | 积分从哪来、怎么没的 |
| 用量统计 / 请求日志 | 趋势与逐条明细（含每条请求花的积分） |
| API Key / 账号管理 / 聊天测试台 | 签发密钥 / 增删账号跑任务 / 免密钥试调模型 |

> **四条通道的账各自独立，不能相加**：搭子靠上游账单 + 余额游标，千问是三个积分池，TRAE 是每账号独立 credits，Qoder 是订阅 + 赠送两块。

## 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DUMATE2API_PORT` / `_HOST` | `9080` / `127.0.0.1` | 网关监听 |
| `DUMATE_REQUIRE_KEY` | 关闭 | 设 `1` 才校验 API Key。**对外暴露必须打开** |
| `DUMATE_DUMATE_SOURCE` | `auto` | 设 `web` = 搭子只用网页凭证，**不需要装客户端** |
| `DUMATE_ADMIN_GATEWAY_PORT` | `9080` | 管理端读哪个网关；开发实例设 `9082` |
| `DUMATE_QWENWORK_AUTOSTART` / `DUMATE_TRAEWORK_AUTOSTART` | `auto` | 设 `off` 关闭对应通道 |
| `DUMATE_AUTO_CHECKIN_HOUR` / `_MINUTE` | `9` / `17` | 每日自动签到（**两个都要设**） |

> 完整列表见 [CLAUDE.md](CLAUDE.md)。`DUMATE2API_KEY` 是历史遗留死变量，真实开关是 `DUMATE_REQUIRE_KEY`。

## 测试

```bash
npm test                        # 冒烟测试（需网关在线）
node test/verify-ccswitch.js    # Codex / Claude / 裸路径 / 模型映射四条链路
node test/verify-qoder-cosy.js  # 签名算法逐字节比对（离线）
node test/verify-fallback-stream-pipe.js  # 回落路径流式转发（离线）
```

更多离线验证脚本见 `test/verify-*.js`，改完对应模块先跑它们。

## 数据与凭证

| 文件 | 内容 | 敏感度 |
|---|---|---|
| `keys.json` | API Key，**只存 sha256** | 低 |
| `web-accounts.json` | 网页账号，**cookie 明文存** | **高** |
| `*-accounts.json`（qwenwork / traework / qoder） | 直连凭证（含 refresh token） | **高（等同密码）** |
| `admin-users.json` / `admin.secret` | 管理员口令与会话密钥 | **高** |

> `data/` 已在 `.gitignore`。**不要提交，不要放进任何备份镜像** —— 凭证被复制走是直接可用的。

## 许可证

[MIT](LICENSE)

---

**免责声明**：本项目是独立的第三方开源项目，与百度 / 阿里（千问办公、Qoder）/ 字节（TRAE）及 Anthropic / OpenAI / Google 等主体无任何隶属、合作或背书关系，文中产品名仅为指代用途。本项目通过协议适配实现与本地已安装客户端的互操作，**不破解、不绕过任何付费墙或授权机制**，**不分发任何上游二进制资产**，也**不上传任何数据** —— 所有凭证与日志只存本机。积分自动化功能可能违反上游服务条款并导致账号受限，**是否使用及其后果由你自行承担**。本项目按「现状」提供，不附带任何担保。有问题请通过仓库 Issue 联系。
