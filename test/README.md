# test/ — dumate2api 自动化测试

零依赖测试基座：Node ≥18 内置 `node:test` + `node:assert`，不引任何第三方包。
离线运行（不出网、不碰真机凭证、不耗积分），`npm test` 全绿是合入门禁。

## 怎么跑

```bash
npm test            # = node --test "test/*.test.js"，只跑 *.test.js
npm run test:smoke  # 真机冒烟（smoke.js，需 9080 活网关、耗真实积分，不属自动化门禁）
```

单跑一个文件：

```bash
node --test test/filelock.test.js
```

退出码语义（CI 友好）：全部通过 → 0；任一失败/异常 → 1。无第三方 reporter 依赖。

## 命名与放置约定

| 位置 | 内容 | 执行方式 |
|---|---|---|
| `test/<模块>.test.js` | 自动化单测，**唯一**被 `npm test` 执行的形态 | node --test |
| `test/helpers/` | 测试夹具（tmpdata、http-mock），不匹配 `*.test.js`，不会被执行 | 被 require |
| `test/helpers/fixtures/` | worker/IO 目标模块（如 offthread 的计算目标） | 被 require |
| `test/smoke.js`、`test/verify-*.js`、`test/probe-*.js` | 真机门禁与探针（**需活网关或真机凭证**） | 手动 / npm run test:smoke |
| `test/_archive/`、`test/mock-upstream.js` | 存档与常驻 mock 进程 | 不属单测 |

注意：新单测必须落在 `test/` 顶层且以 `.test.js` 结尾。**不要**用
`node --test test/`（显式目录形态会把目录里所有 .js 当测试执行，
smoke/verify 探针会被误跑——它们出网耗积分）。

## 新模块随包 TDD（A–E 包约定）

每个新模块随包交付同名测试：`src/pool.js` → `test/pool.test.js`。
行为测试优先测**纯函数与状态迁移**；需要 HTTP 的用 `helpers/http-mock`
起一次性假上游；需要落盘的用 `helpers/tmpdata` 建临时目录，**绝不读写
`data/` 真实运行数据**。

## 夹具规范（test/helpers/）

- `tmpdata.js`
  - `makeTmpData(tag)`：一次性临时目录（mkdtemp），返回 `{dir, file, cleanup}`。
  - `reload(modulePath)`：清 require 缓存重载模块。**网关多个模块在
    require 时固化 env**（`DUMATE_ADMIN_DATA`、`DUMATE_CORS_ORIGINS`…），
    要测不同配置必须「先设 env → reload」，同文件内多套配置靠它切换。
- `http-mock.js` — `startHttp(handler)`：随机端口假上游，handler 收
  `(req, res, bodyBuffer)`，自带 500 兜底与请求计数（`srv.hits`）。
- 夹具本身不写测试逻辑，只提供可复用的环境构造。

## 编写约定

- CommonJS（与 src/ 一致），`const { test } = require('node:test')` +
  `const assert = require('node:assert/strict')`。
- 断言用严格模式；异步用例直接 `async (t) => {...}`。
- 涉及时间的用例（冷却/过期/轮转）要么用相对时间构造输入，要么给被测
  函数传可注入的 now/deadline —— 测试里不许真 `sleep` 等待超时。
- 涉及子进程/worker 的用例（offthread、fileperm 的 icacls）允许慢一点，
  但必须 `unref` / 正常退出，不许让测试进程悬挂。
- 模块加载期固化配置的模块（cors/modelmap/keys…），测加载期行为时用
  `tmpdata.reload`；一个测试文件内不要依赖其他测试文件留下的 env 状态。
