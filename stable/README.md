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
├── src/                  网关文件（协议翻译 + 端口发现 + 鉴权 + 埋点 + 双通道路由）
│   └── qwenwork/         千问办公通道（wasm 桥接 / 凭证解密 / SSE 解包）
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

只在明确要发布新版时做，且要先验证通过。

**别只复制 10 个文件**——`server.js` 的依赖闭包会随功能增长。漏掉一个
依赖，9080 启动时就 `MODULE_NOT_FOUND`。用下面的闭包脚本，它会从
`src/server.js` 递归算出所有本地依赖：

```bash
# 1. 确认开发分支已验证
git log --oneline -1

# 2. 按依赖闭包复制（自动，避免漏文件）
python - <<'EOF'
import os, re
seen, stack = set(), ['src/server.js']
while stack:
    f = stack.pop()
    if f in seen or not os.path.isfile(f): continue
    seen.add(f)
    for m in re.findall(r"require\('(\.[^']+)'\)", open(f, encoding='utf-8').read()):
        base = os.path.normpath(os.path.join(os.path.dirname(f), m))
        for c in (base + '.js', base, os.path.join(base, 'index.js')):
            if os.path.isfile(c): stack.append(c); break
for f in sorted(seen):
    dst = f.replace('src/', 'stable/src/', 1)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(dst, 'w', encoding='utf-8', newline='\n').write(open(f, encoding='utf-8').read())
    print('copied', dst)
EOF

# 3. 复制闭包外的非 .js 资产（wasm_helper.mjs 等，被代码按路径引用）
cp src/qwenwork/wasm_helper.mjs stable/src/qwenwork/

# 4. 记录来源。**工作区脏时不要写 git rev-parse HEAD** ——
#    那会记录一个并不存在的对应关系。照 SNAPSHOT_FROM.txt 里的
#    「base: <hash> + 工作区快照」格式如实写。
git rev-parse HEAD

# 5. 启动 9080 并验证（见下）
```

## 验证快照

```bash
cd stable
DUMATE2API_PORT=9080 DUMATE_ADMIN_DATA=<repo>/data node src/server.js
# 另开终端
node test/smoke.js                    # 32 项断言，打 9080
node test/verify-ccswitch.js          # 四条协议链路
curl :9080/health                     # 看 channels 两个通道是否 ready
```

## 快照包含的能力

- OpenAI：`/v1/chat/completions`、`/v1/models`
- Anthropic：`/v1/messages`、`/v1/messages/count_tokens`
- OpenAI Responses：`/v1/responses`、`/responses`
- Google：`/v1beta/models`、`/v1beta/models/{model}:generateContent`
- **双上游通道**：无前缀 → 搭子 8980；`qwen/` 前缀 → 千问办公（进程内直连）
- 可选 API Key 鉴权（`DUMATE_REQUIRE_KEY=1`，默认关闭）
- 请求埋点（写 `data/requests.jsonl`，含 `channel` / `first_token_ms` 字段）

**快照里的千问通道依赖运行时资产**：官方 `qoder_auth_wasm_bg.wasm` 必须从
千问办公客户端安装目录读取（`wasm-path.js` 自动探测），**不随快照分发**。
客户端没装或未登录时，`/health` 的 `channels.qwenwork.ready` 报 false，
搭子链路不受影响。
