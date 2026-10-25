# 新上游接入模板（channel-skel）

> 底本：`src/qoder/`（家族最新的通道包）。适用范围：dumate2api 与家族项目
> （zcode-hub 等）新增直连上游。本文是 buddy2api 五步清单与七件套在
> dumate2api 形态下的固化，按顺序做完即可接入。

## 0. 三要素（动手前先回答，写进通道包 README）

Buddy2api 五步清单的第一步——接入前必须明确、且要文档化三件事：

| 要素 | 落点 | dumate2api 约定 |
|---|---|---|
| 凭据落盘 | `data/<ch>-accounts.json` | 凭证**自持**（Device Flow / 浏览器抓 cookie / playwright 窗口），不依赖上游客户端目录；文件里不存明文手机号等 PII |
| endpoint | `src/<ch>/constants.js` | host、路径、客户端版本号、静态兜底模型表全在这一个文件，代码里不散落硬编码 URL |
| 模型清单 | `constants.js` 静态表 + 运行时拉取 | 运行时拉上游真实表（带倍率/上下文档位），失败回落静态表；两者可信度在界面上分开标注 |

## 1. 七件套骨架

每条直连通道一个目录 `src/<ch>/`，七件对应关系（Buddy2api → dumate2api）：

| # | 件 | 文件 | 要点 |
|---|---|---|---|
| 1 | 通道注册入口 | `index.js` | facade：`status / send / listModels / listModelEntries / pickAccount`。`chatCompletion` 与 `chatCompletionStream` 两个导出形态与网关调用习惯对齐 |
| 2 | 上游方言 | `chat.js` | 只管**上游侧**请求体/响应帧；客户端四协议（OpenAI/Anthropic/Google/Responses）的翻译集中在网关 `src/anthropic.js` 等，**不要每通道内嵌翻译** |
| 3 | 凭据获取 | `login.js` | 自持凭证；刷新入口暴露为可调用函数（保活调度要轮跑它，GAP F2） |
| 4 | 凭据持久化 | `store.js` | **本模板补齐的缺项**。复制 `store.js` 骨架，填 CHANNEL 块；管理端路由只调它，不碰文件 |
| 5 | 额度快照 | `credits.js` | dumate2api 的归因模式（逐请求/差值游标/批次账本）是家族最深，直接照抄对应形态，不要简化 |
| 6 | 请求签名 | `cosy.js` / `headers.js` | 签名原语可与其他通道共享（`src/cosy.js`），但通道包独立——铁律 5：相似厂商不合并单例 |
| 7 | 常量 | `constants.js` | 见三要素 |

错误识别**不要**在通道内重写形状判据——统一走 `src/upstream-errors.js`
（单一来源。判据复制两份必然漂移，2026-10-22 的 `provider_error` 小写
漏判事故就是这么来的）。

## 2. 协议契约（一页版，接入时逐条自检）

1. **显式前缀分流**：新通道在 `src/upstream-router.js` 的 `UPSTREAMS` 表注册，
   前缀即契约（`<ch>/model`）。未知前缀**报 400 不回落**——静默跑到别的通道
   会拿到「看起来成功但完全不是想要」的结果（GLM 系模型名两侧都有，必然撞车）。
2. **availability 全通道强制**：`availability()` 里给新通道加分支，判定形状
   统一调 `index.js` 的 `status()`（`ready` + `error`）。漏分支 = 零账号也报
   可用，预检形同虚设（qoder 漏过，2026-10-25 补）。
3. **错误形状判据单一来源**：`upstream-errors.js` 收口；通道只负责把上游
   错误**抛成带 statusCode 的 Error**。
4. **flag 默认关，冒烟后进 registry**：新通道 `_AUTOSTART` 先 `off`，真机
   冒烟（`test/verify-<ch>-*.js`）通过后再放开。默认 `auto` = 跳过门禁。
5. **retryable 只按数字 code 判，不匹配 message**：401/402/429/5xx 换号，
   其余 4xx 是请求本身的问题；403 只有明确「模型对该账号不可用」才换号。
6. **归因上报是权威来源**：多账号轮询下「这次实际用了谁」由通道在选中账号时
   经 `opts.onAccount` / `req._upstreamAccount` 上报，埋点处不猜。
7. **流式已吐帧不可换号**：`err.sent = true` 后原样抛出，客户端已收到半截
   输出，重试会输出两遍。

## 3. 接入五步（buddy2api 清单 → dumate2api 动作）

| 步骤 | 动作 | 完成判据 |
|---|---|---|
| 1. 三要素 | 写通道包 README（凭据/endpoint/模型清单） | 三问各有唯一答案 |
| 2. 七件套 | 复制本目录骨架，`store.js` 填 CHANNEL 块 | 管理端路由只调 store 方法 |
| 3. 协议契约 | router 注册 + availability 分支 + 错误走 errors.js | 本文第 2 节逐条自检过 |
| 4. flag 默认关 | `_AUTOSTART = 'off'` 起步 | 冒烟脚本全绿才放开 |
| 5. quota/checkin | `credits.js`（+ 签到/批次账本按上游形态） | 归因不依赖文本匹配判幂等 |

## 4. 写盘纪律（全通道强制，出处 src/filelock.js）

- mtime 失效重读（跨进程可见性）
- tmp+rename 原子写（崩溃不留半截 JSON）
- filelock 包住一切读改写（refresh token 轮换的赛道，旧快照盖新 token = 写废账号）
- token 文件 0600 + `fileperm.harden`

## 5. 真机冒烟约定

- 调试消耗积分的活动一律用 **0.1 档**（档位差 14 倍，见 qoder 模型表注释）。
- verify 脚本进 `test/`，命名 `verify-<ch>-<场景>.js`；离线单测进
  `test/unit/`（node:test，零依赖），两者分层：verify 是真机门禁，unit 是回归网。
