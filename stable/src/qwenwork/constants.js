// src/qwenwork/constants.js - 千问办公数据面常量
//
// 全部实测自本机千问办公 1.1.0-26091701（2026-09-23 直连 gateway.qwenwork.cn
// 验证通过）。这些值随官方客户端版本变化，写在这里而不是散在代码里，
// 便于版本升级时一处改完。
//
// 已知的版本敏感项：
//   - COSY_VERSION 来自 qoderclicn 二进制（1.1.0 桌面端实测 1.1.52）
//   - CHAT_QUERY 必须带 Encode=1（1.1.0 起要求，缺了会 400）
//   - 请求体必须带 business 对象，否则无论签名是否正确都 503
//     "Model catalog unavailable"
const CHANNEL_ID = 'qwenwork';
const DISPLAY_NAME = '千问办公 / QwenWork';

const GATEWAY = 'https://gateway.qwenwork.cn';
const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
const CHAT_QUERY = 'FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';
const REFRESH_PATH = '/api/v1/deviceToken/refresh';
const MODELS_PATH = '/api/v2/model/list';

// 客户端身份：必须与请求头声明的一致。用 CLI 的 cli/5/assistant 三元组
// 会让 body 与 header 自相矛盾，服务端直接拒。
const IDE_VERSION = '1.1.0';
const RELEASE_VERSION = '1.1.0-26091701';
const BUILD = '26091701';
const COSY_VERSION = '1.1.52';
const CLIENT_TYPE = '6';
const BUSINESS_PRODUCT = 'qoder_work';
const BUSINESS_TYPE = 'agent';
const SCENE = 'qwork';
const MACHINE_OS = 'x86_64_win32';
const LOGIN_VERSION = 'v2';
const USER_AGENT = 'qoderwork/1.1.0';

// 模型目录会随服务端变化（1.1.0 实测只有 flash / pro / qwen3.8-max-preview，
// 旧版的 qwork-advanced 等已不存在），所以这里只作兜底，实际以
// /api/v2/model/list 为准。
const FALLBACK_MODELS = ['pro', 'flash'];
const DEFAULT_MODEL = 'pro';
const MODEL_ALIASES = { auto: 'pro', 'qwork-advanced': 'pro', 'qwork-auto': 'pro' };

module.exports = {
  CHANNEL_ID,
  DISPLAY_NAME,
  GATEWAY,
  CHAT_PATH,
  CHAT_QUERY,
  REFRESH_PATH,
  MODELS_PATH,
  IDE_VERSION,
  RELEASE_VERSION,
  BUILD,
  COSY_VERSION,
  CLIENT_TYPE,
  BUSINESS_PRODUCT,
  BUSINESS_TYPE,
  SCENE,
  MACHINE_OS,
  LOGIN_VERSION,
  USER_AGENT,
  FALLBACK_MODELS,
  DEFAULT_MODEL,
  MODEL_ALIASES,
};
