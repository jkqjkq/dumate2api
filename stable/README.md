# 稳定版快照（9080）

这个目录是**冻结的快照**，不随开发改动。它跑在 9080 端口，供 cc-switch /
Codex CLI / Claude Code 等客户端长期使用。

## 为什么要快照

主目录的代码是开发前沿，随时会改。而 9080 上跑的服务一旦被改动波及，
正在用的客户端就会断。快照把「已验证可用」和「正在开发」彻底分开。

快照来源见 `SNAPSHOT_FROM.txt`（记录提交号与时间）。

## 目录内容

```
stable/
├── src/                  10 个网关文件（协议翻译 + 端口发现 + 鉴权 + 埋点）
├── start-stable.bat      启动稳定版（9080）
└── SNAPSHOT_FROM.txt     快照来源提交
```

快照只包含网关，**不含管理端**——管理端是运维工具，不需要长期冻结，
而且它读的 `data/` 与主目录共用（通过 `DUMATE_ADMIN_DATA` 指向主目录的 data）。

## 端口分工

| 端口 | 用途 | 启动方式 |
|---|---|---|
| 8980 | DuMate 后端（上游） | 由网关自动拉起，三套实例共用同一个 |
| 9080 | **稳定版网关** | `stable\start-stable.bat` |
| 9081 | 稳定版管理端（可选） | 见下方 |
| 9082 | 开发网关 | `start-dev.bat` |
| 9083 | 开发管理端 | `start-dev.bat` |

三套实例共用同一个上游（8980）：发现链路会先探已知端口，发现 8980 已在
服务就直接复用，不会重复拉起后端进程。

## 启动

```
stable\start-stable.bat          # 稳定版网关，9080
start-dev.bat                    # 开发实例，9082 + 9083
```

稳定版管理端（可选，用于观察 9080）：

```
set DUMATE_ADMIN_PORT=9081
set DUMATE_ADMIN_GATEWAY_PORT=9080
node src\admin\server.js
```

## 更新快照

只在明确要发布新版时做，且要先验证通过：

```bash
# 1. 确认开发分支已验证
git log --oneline -1

# 2. 覆盖快照
cp src/server.js src/discovery.js src/anthropic.js src/budget.js \
   src/google.js src/responses.js src/reqlog.js src/modelmap.js \
   src/keys.js src/upstream-launcher.js stable/src/

# 3. 记录来源
git rev-parse HEAD > stable/SNAPSHOT_FROM.txt
git log --oneline -1 >> stable/SNAPSHOT_FROM.txt

# 4. 重启 9080 并验证四条协议
```

## 快照包含的能力

当前快照（含 `/v1/responses`，Codex 0.155+ 必需）：

- OpenAI：`/v1/chat/completions`、`/v1/models`
- Anthropic：`/v1/messages`、`/v1/messages/count_tokens`
- OpenAI Responses：`/v1/responses`、`/responses`
- Google：`/v1beta/models`、`/v1beta/models/{model}:generateContent`
- 可选 API Key 鉴权（`DUMATE_REQUIRE_KEY=1`，默认关闭）
- 请求埋点（写 `data/requests.jsonl`）
