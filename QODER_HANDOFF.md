# Qoder 通道接入 —— 交接记录

> 记录时间：2026-10-03（会话上下文超 50%，主动交接）
> 分支：`dev`　｜　状态：**功能完整、已验证、已提交、快照已同步**
>
> **2026-10-03 收尾更新**：交接项全部处理完毕，见文末「九、收尾结果」。
> 提交 `9736b11`（通道代码）+ `578d8b0`（快照同步）。**9080 未启动**
> （按约定只同步快照文件，是否启动是对外服务的决定，由用户定）。

---

## 一、这次做了什么

把**阿里 Qoder**（qoder.com / qoder.com.cn）接入成本项目的**第四条上游通道**，
从可行性调研一路做到管理端界面。

| 阶段 | 产出 | 验证 |
|---|---|---|
| 可行性调研 | `/tmp/qoder-probe/`（未进仓库） | 签名逐字节比对 Go 参考实现 **22/22** |
| 最小闭环 | `src/qoder/`（7 文件） | 四协议全通 |
| 网关接入 | `channels.js` / `upstream-router.js` / `server.js` / `budget.js` / `model-info.js` | `/v1/models` 列 14 个 |
| 管理端 | `admin/routes/qoder.js` + 前端 6 个文件 | 界面可用 |
| 积分过期 | `src/qoder/grants.js` + 仪表盘明细 | 14 项离线测试 |
| 模型列表显示名 | `/v1/models` 四通道带 `name` | **39/39 有 name** |

---

## 二、Qoder 是什么（关键事实）

**与千问办公同一套 COSY 协议栈**——同样的 `Encode=1` 自定义 base64、同样的
`Bearer COSY.<payload>.<sig>` 信封、同样的 device flow 登录，**连 client_id 都相同**
（`e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`）。可视为「同一平台的两个产品」。

### 与千问的两个决定性差异

**1. 签名不需要官方 wasm**（这是最大的优势）

- 千问：请求体必须由 `qoder_auth_wasm_bg.wasm` 生成，**所以要装客户端**
- Qoder：签名是**纯本地算法**（RSA + AES + MD5，公钥硬编码）→ **不依赖任何客户端**

`/health` 里 `qoder.needsClient: false` 明确标注了这点。

**2. 额度分两块且不能相加**

- `userQuota`：订阅套餐内（Free 套餐恒为 0）
- `addOnQuota`：签到/赠送（**免费用户实际能用的就是这个**）

---

## 三、已实现的功能（全部实测通过）

### 签名（`src/qoder/cosy.js`）

```
cosyKey = base64( RSA_PKCS1v15( tempKey ) )
info    = base64( AES-128-CBC( 身份JSON, tempKey ) )   ← IV = tempKey[:16]，PKCS#7
sig     = md5( payloadB64 + "\n" + cosyKey + "\n" + date + "\n" + body + "\n" + pathSig )
Authorization: Bearer COSY.<payloadB64>.<sig>
```

**两个踩过的坑**（都会导致 `Signature invalid`，极难自查）：

1. **JSON key 必须字母序**——Go 的 `json.Marshal(map)` 排序 key，JS 的 `JSON.stringify`
   用插入顺序；顺序不同 → AES 密文不同 → 拒签
2. **Node 的 AES 必须 `setAutoPadding(false)`**——Go 侧已手工 PKCS#7，Node 默认再补一次

### 登录（`src/qoder/login.js`）

OAuth Device Flow + PKCE，与千问同构。`qoder-cli.js login [cn|global]` 可直接跑。

### 聊天（`src/qoder/chat.js` + `index.js`）

四协议全通（OpenAI 非流式/流式、Anthropic、Responses、Google）。

**模型选择要同时设 body 与请求头**：

- body：`model_config.key` / `chat_context.extra.modelConfig.key`
- 请求头：`x-model-key` / `x-model-source`

只设 body 时上游仍走 `auto`。**响应里的 `model` 字段恒为 `"auto"`**（上游如此），
判断实际模型只能看 `system_fingerprint`（实测 `dmodel` → `a307abda…`、
`kmodel_latest` → `fpv0_3f6baf1…`）。

### 签到（`session.js` 的 `checkin`）

`GET /sash/api/v1/me/campaigns` → `POST .../{id}/claim`，**不需要签名**，
只要 device token + `cosy-clienttype: 10`。幂等，返回**实际到账差值**（不是总额）。

**零额度时聊天会挂起**（不报错、不超时），所以**签到是通道可用的前提**。

### 积分过期账本（`src/qoder/grants.js`）

**为什么需要**：Qoder **没有逐批积分余额接口**——实测
`/api/v2/quota/detail`、`/sash/.../grants`、`/sash/.../credit-packs` 等一律 503/404。
**唯一带到期信息的是领取响应本身**（`benefit.validity` = `RELATIVE_DAYS`/30 天 + `grantedAt`）。

所以每次签到往 `data/qoder-grants.jsonl` 落一条（幂等键 `grantId`）。

**「领取额」≠「剩余额」**：上游只说领了多少，不说还剩多少。千问（每包独立余额）
与 TRAE（每包有 `remain`）都没这个问题，**界面措辞不要照搬**。

**签到积分领取后 30 天作废、每日 10:00 (UTC+8) 刷新**——注意**不是 00:00**。

### 管理端

- 后端：`admin/routes/qoder.js`（status / models / credits / checkin / grants / dashboard / login / accounts）
- 前端：`api/qoder.ts`、`components/qoder/{QoderAccounts,QoderLoginView}.vue`、
  通道 store + 顶栏 + 仪表盘/模型/账号页分支
- 仪表盘账号健康快照**每张卡显示积分剩余**（签到积分 + 套餐内额度分开，健康条按签到积分占比）
- 模型页带**倍率**（`price_factor`），0.1 档标「省额度」

---

## 四、当前状态（已核实）

### 服务

| 端口 | 进程 | 状态 |
|---|---|---|
| 9082 | 开发网关（本会话改的） | ✅ 在跑 |
| 9083 | 开发管理端 | ✅ 在跑 |
| 15721 | cc-switch 代理 | ✅ 在跑 |
| **9080** | **生产实例** | **未运行**（按需启动，符合预期） |

### 测试

```
离线测试 10/10 通过：
  verify-qoder-cosy / verify-qoder-channel / verify-qoder-grants
  verify-qwen-wallets-zero / verify-qwen-daily-aggregate / verify-qwen-discipline
  verify-channel / verify-truncated-toolcall / verify-traework-gained / verify-display-name

四协议实测（qoder/qfmodel）：openai 200 / anthropic 200 / responses 200 / google 200
```

### 账号池（`data/qoder-accounts.json`）

| id | 昵称 | 区域 | 套餐 | 签到积分 | 套餐内 |
|---|---|---|---|---|---|
| 1 | aliyun8745841618 | cn | Free | 100 | 0 |
| 2 | 1251104 | cn | 有套餐 | 100 | 300 |

### cc-switch 配置（`~/.cc-switch/cc-switch.db`）

已建两条 **未激活**（`is_current=0`）的 provider：

| app | provider id | 模型 |
|---|---|---|
| claude | `qoder9082-cheap-claude` | 四档位：opus=qfmodel / sonnet=gfmodel / fable=qmodel / haiku=dfmodel |
| codex | `qoder9082-cheap-codex` | catalog 四个 + 手动加的 `qoder/kmodel_latest` |

**当前激活**：claude=`wb-2key-intl-claude`，codex=`dumate9082-dumate-codex`（你切回搭子了）

---

## 五、⚠️ 未完成 / 待办

### 1. 模型列表显示名 —— 需要你在 cc-switch 里重新激活一次

**背景**：cc-switch 解析模型列表读 `name` 字段（从其二进制确认：与 `owned_by`
相邻的字段是 `id / name / cost / contextWindow / maxContextWindow`）。
我们原来只返回 `{id, object, created, owned_by}`，**没有 `name`**，
所以只显示内部 key（`qoder/qfmodel`）。

**已修**：`/v1/models` 现在四通道都带 `name` + `contextWindow`（39/39 有 name）。

**待你操作**：在 cc-switch 里**重新激活一次** `Qoder 最低消耗 4 模型 (9082)`（codex 侧），
让它重新拉取模型列表。`cc-switch-model-catalog.json` 是**激活时生成**的，不重新激活不会更新。

### 2. provider 级上下文覆盖已写入，但未验证激活后是否保留

我给 `qoder9082-cheap-codex` 的 config 加了：

```toml
model_context_window = 180000
model_auto_compact_token_limit = 153000
```

**为什么**：cc-switch 的**全局** `common_config_codex` 写着 `model_context_window = 1000000`，
注入到所有 codex provider。但 Qoder 只有 `gfmodel` 是 1M，其余是 **180K**——
声明虚高会让 Codex 到 950K 才压缩历史，而 Qoder 180K 就拒了，**长对话静默失败**。

**未验证**：激活时 cc-switch 是否保留 provider 级覆盖（可能被全局值覆盖回去）。
重新激活后请检查 `D:\codex-home\config.toml` 的 `model_context_window`。

### 3. 未提交

所有改动都在工作区，**没有 commit**。见「六、改动清单」。

### 4. 未发布到 9080

按项目约定，发布需要**按依赖闭包同步 `stable/` 快照**（不能简单 `cp src/*.js`——
会漏 `qoder/` 子目录、又会多带管理端）。详见 `CLAUDE.md` 的「`stable/` 是冻结快照」。

### 5. 一次「空响应」未定位

埋点显示 23:27 有一次 `qoder/kmodel_latest` 请求 `input=0, output=0`（空输出）。
怀疑与「catalog 元数据缺失」或「上下文声明虚高」有关，两者都已修，但**未复现验证**。

---

## 六、改动清单

### 新增（`??`）

```
src/qoder/                        ← 通道实现（7 文件）
  constants.js  cosy.js  auth.js  session.js  login.js  chat.js  index.js
  grants.js                       ← 积分批次账本
src/admin/routes/qoder.js         ← 管理端路由
test/qoder-cli.js                 ← 命令行自测（不开管理端也能验证）
test/verify-qoder-cosy.js         ← 签名（22 项）
test/verify-qoder-channel.js      ← 通道逻辑（27 项）
test/verify-qoder-grants.js       ← 积分账本（14 项）
web/src/api/qoder.ts
web/src/components/qoder/         ← QoderAccounts.vue / QoderLoginState.vue
web/src/utils/lastError.ts        ← lastError 新鲜度（共享）
```

### 修改（`M`）

```
CLAUDE.md                          ← 加 Qoder 章节（通道表、协议差异、数据缺口）
src/channels.js                    ← 加 qoder 通道 id
src/upstream-router.js             ← 加 qoder/ 前缀 + QODER_PREFIX 导出
src/server.js                      ← 路由 + /health + /v1/models（四通道带 name）
src/budget.js                      ← resolveQoderMaxTokens（独立下限 16384）
src/model-info.js                  ← qoderRows（自己拉，不读跨进程快照）
src/admin/server.js                ← 挂载 /api/admin/qoder
src/admin/routes/system.js         ← channels.qoder
src/traework/index.js              ← listModelEntries（给 /v1/models 带 name）
src/traework/models.js             ← cachedModelEntries
src/qwenwork/*                     ← 上一轮修的（余额交叉验证、lastError 时间戳等）
web/src/stores/channel.ts          ← isQoder + channelParam
web/src/layouts/MainLayout.vue     ← titleFor 修「wasm 未知」误报
web/src/views/{Dashboard,Models,Account,WebAccounts}View.vue
web/src/api/qwenwork.ts
web/src/components/qwenwork/QwenworkAccounts.vue
test/verify-qwen-wallets-zero.js
```

### cc-switch 目录（不在仓库）

```
~/.cc-switch/add_qoder_cheap_providers.py    ← 建两条 provider（幂等）
~/.cc-switch/fix_qoder_display_names.py      ← 修显示名 + 上下文覆盖（幂等）
```

### 备份

数据库备份在 `~/.cc-switch/backups/`（每次改动前自动），本次会话有 5+ 份。
`D:\codex-home\cc-switch-model-catalog.json` 与 `config.toml` 也有 `.bak-*`。

---

## 七、下个会话怎么接

### 快速确认状态

```bash
cd D:/code/project/codexProject/dumate2api
node test/verify-qoder-cosy.js      # 签名
node test/verify-qoder-channel.js   # 通道逻辑
node test/qoder-cli.js status       # 账号与就绪状态
node test/qoder-cli.js chat "你好"   # 真实对话（默认用最省的 gfmodel）
curl -s http://127.0.0.1:9082/health | node -e "..."   # 四通道就绪
```

### 优先事项（按建议顺序）

1. **验证 cc-switch 重新激活后的效果**（待办 1、2）
2. **提交代码**（待办 3）——`git add` 后 commit 到 `dev`
3. **发布到 9080**（待办 4）——按依赖闭包同步 `stable/`
4. 若时间允许：定位那次空响应（待办 5）

### 硬性约定（务必遵守）

- **调试一律用 0.1 档模型**：`qfmodel`(免费) / `gfmodel` / `qmodel` / `dfmodel`
  ——档位差 14 倍（`kmodel_latest` 是 1.4）
- **倍率从上游 `price_factor` 读，不硬编码**
- **「领取额」不是「剩余额」**——界面上不要照搬千问/TRAE 的措辞
- **翻译层禁止 `mapModel`**——否则 `qoder/` 前缀丢失、静默落到搭子返回 200
- **`.bat` 必须纯 ASCII**

---

## 八、参考

- 参考实现：[wangtufly/QCCG](https://github.com/wangtufly/QCCG)（GPL-3.0，**勿直接抄代码**，
  协议是事实标准但代码表达受版权保护）
- API 参考：[alingse/qodercli-reverse](https://github.com/alingse/qodercli-reverse)
- 项目内文档：`CLAUDE.md` 的「Qoder 是第四条通道」章节

---

## 九、收尾结果（2026-10-03）

### 已提交

| 提交 | 内容 |
|---|---|
| `9736b11` | `feat(qoder): 接入第四条上游通道（阿里 Qoder）` |
| `578d8b0` | `chore(stable): 同步快照到 9736b11（Qoder 通道）` |

均在 `dev`。快照指纹 `3662af33a5017af3c411a5a723623deed5597f44eaed910da974041eedb37aa9`
（43 文件）。**注意**：历史记录过的 f7e7a810 / 96a22d7c / 8548df35 三个指纹
**均不可复现**——本次按文档算法对旧快照内容实算得 `395350d0…`，又试了 6 种
变体仍无匹配，确认那三个值写入时就与任何一致算法不符。已在 `SNAPSHOT_FROM.txt`
如实标注。

### 快照同步（`578d8b0`）

- 闭包从 `src/server.js` 递归解析，**43 个文件**（36 → 43，新增 `qoder/` 7 个）
- 逐字节比对：43 = 43，内容全等，反向检查无多余文件
- `node --check` 43 个全通过
- 独立启动（临时端口 19099，`DUMATE_AUTOSTART=off`，指向 `<repo>/data`）：
  `/health` 四通道 `ready=true`、`qoder.needsClient=false`；
  `/v1/models` 39 个模型、**39/39 带 name**（dumate 3 / proxy 2 / qwen 2 /
  trae 18 / qoder 14）

**顺带修掉一个旧快照的陈旧文件**：`stable/src/qwenwork/wasm-path.js` 停留在
脱敏之前——注释里还写着本机真实路径 `D:\Program Files\code program\...`，
而主目录早在 2026-10-01 公开前脱敏时就已换成占位符。该文件在 git 里自
`4262fee` 起未再改动，所以**历次「按闭包同步」都漏掉了它**：闭包同步只复制
闭包内的文件，不检查它们是否已过期。本次逐字节比对**全部**闭包文件才发现。

> **教训**：同步时应逐字节比对全部闭包文件，而不只比对本次改过的那些。

### 待办 1 —— 已解决

cc-switch 已重新激活过（`cc-switch-model-catalog.json` 于 23:43 重新生成）。
5 条 Qoder 模型均带 `display_name`，与网关输出逐条对上：

| catalog display_name | id | ctx |
|---|---|---|
| Qwen3.8-Flash | `qoder/qfmodel` | 180000 |
| GLM-5.3-Flash | `qoder/gfmodel` | **1000000** |
| Qwen3.7-Plus | `qoder/qmodel` | 180000 |
| DeepSeek-Flash | `qoder/dfmodel` | 180000 |
| Kimi-K3 | `qoder/kmodel_latest` | 180000 |

### 待办 2 —— 已解决（成因与交接时猜测不同）

**provider 级的 `model_context_window = 180000` 确实没生效**——生效的
`D:\codex-home\config.toml` 是 `1000000`，被 cc-switch 全局 `common_config_codex`
（写着 `1000000` / `900000`）覆盖了。

但 `config.toml` 里 `model = "qoder/kmodel_latest"` 与 provider 存的
`qoder/qfmodel` **不一致**，说明 config.toml 被手改过（换模型 + 保留 1M），
所以不能简单断定「provider 级覆盖必被吃」。

**已按用户决定修**：`D:\codex-home\config.toml` 改为
`model_context_window = 180000` / `model_auto_compact_token_limit = 153000`
（备份 `config.toml.bak-ctx180k-20261002162630`）。理由：当前模型
`kmodel_latest`(Kimi-K3) 实际只有 **180K**，声明 1M 会让 Codex 到 ~900K
才压缩历史，而上游 180K 就拒——长对话静默失败。

**未验证**：Codex 是否优先读 `model_catalog_json` 里 per-model 的
`context_window`。若优先读 catalog，则原本就无风险。此点无法离线确认。

### 端到端实跑（2026-10-03）

```
node test/qoder-cli.js chat "只回复两个字：收到"
→ HTTP OK (2788ms) | model=gfmodel | credits=0.0056 | 正文「收到」
```

### 仍未做

- **未发布到 9080**：快照文件已同步，但 9080 未启动。要对外提供就按
  `stable/start-stable.bat` 启动（它设了 `DUMATE_ADMIN_DATA=<repo>/data`）。
- 交接里那次「空响应」（`kmodel_latest` 请求 `input=0,output=0`）**仍未复现**，
  怀疑的两处（catalog 元数据缺失、上下文声明虚高）都已修。
- 前端未 `npm run build`：`web/dist` 被 gitignore，若要用管理端界面看 Qoder
  页面，需在 `web/` 下跑一次构建。
