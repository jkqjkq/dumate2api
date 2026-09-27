// web/src/api/qwenwork.ts - 千问办公通道的接口类型
import client from '@/api/client'

export interface QwWallet {
  id: 'daily' | 'monthly' | 'longterm'
  label: string
  kind: 'free' | 'paid'
  balance: number | null
  /** 免费额度每天 00:00 重置，接口给出该时刻；付费池按有效期，为 null */
  resetAt: string | null
}

export interface QwCredits {
  ok: boolean
  error: string
  /** 三个池子平级返回，不合并——月度与长期性质不同 */
  wallets: QwWallet[]
  /** 免费额度余额（每日 00:00 重置） */
  free: number
  /** 付费余额 = monthly + longterm */
  paid: number
  monthly: number
  longterm: number
  total: number
  /**
   * 每日上限，**由观测峰值 + 配置兜底得出**（接口本身不给上限）。
   * 每日额度每天 00:00 重置，当天观测到的最大值即最接近上限的真实值。
   */
  limit: number
  limitSource: 'observed' | 'config-lower-bound'
  /**
   * 每日免费额度的**配置上限**（默认 100）。接口不返回分母，
   * 这个值来自配置——界面标注「/ 100」时必须说明来源，否则额度政策一变
   * 就没人知道数字是错的。
   */
  dailyCap: number
  /** 当天观测到的每日额度峰值 */
  peak: number
  /** true = 峰值已追平/超过配置值（已观测到接近满额状态），消耗值可信 */
  calibrated: boolean
  /** 今日全部消耗 = 上限 − 余额（含客户端/网页里的对话） */
  freeUsed: number | null
  /**
   * 最近到期的钱包。**注意这不是「积分要作废」**：daily 池每天 00:00 重置，
   * 所以 valid_to 就是明天的重置时刻——每天都「即将到期」，不是风险。
   * kind='reset' 标出这一点，界面不要把它渲染成风险。
   */
  expiring: Array<{ balance: number; valid_to: string; kind?: 'reset' | 'expire' }>
  /**
   * 上游自己给的「即将过期」列表——**这才是会作废的那部分**（付费积分
   * 按有效期，过期即消失）。count 为 0 表示无风险。
   */
  expiringSoon: { count: number; total: number; wallets: Array<{ balance: number; valid_to: string }> }
  fetchedAt: number
  /**
   * 今日消耗。**仅统计经本网关的请求**——客户端/网页里的对话不经网关，
   * 不计入这里。与「当天总消耗」是两套口径，不要把两者相加或对比。
   */
  today: { free: number; paid: number; total: number; requests: number; scope: 'gateway' }
}

export interface QwDailyRow {
  day: string
  free: number
  paid: number
  total: number
  requests: number
  concurrent: number
}

export interface QwModel {
  id: string
  name: string
  prefixed: string
}

/** 归因里附带的账号信息（千问是单账号直连，但字段留着方便以后扩展） */
export interface QwAccountInfo {
  id: string
  name: string
  tier: string
  planId: string
}

/** 千问登录态（只读）。来自官方客户端的 auth-v2.dat */
export interface QwLogin {
  ok: boolean
  error: string
  file: string | null
  fileStat: { size: number; mtime: number } | null
  machineId: string
  account: {
    id: string
    name: string
    username: string
    email: string
    tier: string
    planName: string
    planId: string
    planSubscriptionActive: boolean
    planNextDueDate: string | null
    isBiz: boolean
    orgName: string | null
    entitlements: {
      pageQuota?: number
      monthRequests?: number
      monthTraffic?: string
    } | null
  } | null
  token: {
    accessExpiresAt: number | null
    refreshExpiresAt: number | null
    accessExpired: boolean
    refreshExpired: boolean
  }
  ready: boolean
  wasm: string | null
}

/** 积分逐笔记录（来自归因历史） */
export interface QwCreditRecord {
  ts: number
  req_id: string
  model: string
  ms: number | null
  free: number
  paid: number
  total: number
  pool: 'daily' | 'paid' | 'none'
  concurrent: boolean
  balance: { daily: number; monthly: number; longterm: number } | null
  account: QwAccountInfo | null
}

/**
 * 千问办公账号。
 *
 * 2026-09-25 起是多账号池：凭证由本项目通过 device flow 自行换取，
 * 存 data/qwenwork-accounts.json，可增删、可停用、可指定主账号。
 */
export interface QwAccount {
  id: string
  name: string
  username: string
  email: string
  /** 脱敏手机号（如 157****1251）。完整号码是 PII，接口不外传 */
  phone: string
  tier: string
  planName: string
  /** 主账号（当前在用）。故障时会自动转移到下一个可用账号 */
  active: boolean
  enabled: boolean
  usable: boolean
  /** 账号存活天数（仪表盘账号健康快照用，从 createdAt 算） */
  daysAlive: number | null
  /** 三池积分合计（仪表盘账号健康快照用） */
  points: number | null
  tokenExpiresAt: number | null
  refreshExpiresAt: number | null
  refreshExpired: boolean
  machineId: string
  lastError: string
  /** refresh token 尾 6 位，供人工核对是哪个账号。全量不外传 */
  refreshTail: string
  wallets: { daily: number; monthly: number; longterm: number; total: number } | null
  /** 该账号即将过期的积分（上游 expiring_soon）。count=0 表示无风险 */
  expiringSoon: { count: number; total: number; wallets: Array<{ balance: number; valid_to: string }> }
}

/** /qwenwork/accounts 的汇总（顶部指标卡用，口径与搭子对齐） */
export interface QwAccountsSummary {
  total: number
  enabled: number
  disabled: number
  /** 有效期内 = 凭证可用（enabled 且未 refreshExpired） */
  valid: number
  /** 有即将过期积分的**账号数** */
  expiringSoon: number
  /** 即将过期积分的**总量**——用户关心的是会作废多少积分 */
  expiringSoonPoints: number
  pointsTotal: number
}

/** device flow 登录：一次登录会话 */
export interface QwLoginSession {
  ok: boolean
  url: string
  nonce: string
  machineId: string
  hint: string
}

/** 轮询取票的返回 */
export interface QwLoginPoll {
  status: 'pending' | 'ok' | 'error'
  /** pending 时是已等待毫秒数 */
  waited?: number
  account?: QwAccount
  error?: string
}

export const qwenworkApi = {
  credits: () => client.get<QwCredits>('/qwenwork/credits'),
  daily: (days = 14) => client.get<{ days: number; rows: QwDailyRow[] }>(`/qwenwork/credits/daily?days=${days}`),
  models: () => client.get<{ models: QwModel[]; error: string }>('/qwenwork/models'),
  status: () => client.get<{
    ready: boolean; loggedIn: boolean; error: string;
    wasm: string | null;
    account: string; tier: string; planId: string;
    tokenExpiresAt: string | null;
    refreshExpiresAt: string | null;
    refreshExpired: boolean;
  }>('/qwenwork/status'),
  // 登录态详情（只读）
  login: () => client.get<QwLogin>('/qwenwork/account'),
  // 积分逐笔明细
  creditRecords: (limit = 100) =>
    client.get<{
      limit: number
      rows: QwCreditRecord[]
      window: { free: number; paid: number; total: number; requests: number }
    }>(`/qwenwork/credits/records?limit=${limit}`),
  // 账号列表（多账号池，mode='multi'）
  accounts: () => client.get<{
    mode: 'single' | 'multi'
    modeNote: string
    count: number
    accounts: QwAccount[]
    /** 顶部指标卡用（账号总数 / 有效期内 / 即将过期 / 积分余额） */
    summary: QwAccountsSummary
    error: string
  }>('/qwenwork/accounts'),
  // ---- 以下为多账号后的写接口 ----
  loginStart: () => client.post<QwLoginSession>('/qwenwork/login/start'),
  loginPoll: (nonce: string) =>
    client.post<QwLoginPoll>('/qwenwork/login/poll', { nonce }),
  loginCancel: (nonce: string) =>
    client.post<{ ok: boolean }>('/qwenwork/login/cancel', { nonce }),
  removeAccount: (id: string | number) => client.delete(`/qwenwork/accounts/${id}`),
  patchAccount: (id: string | number, fields: { enabled?: boolean; preferred?: boolean }) =>
    client.patch<{ ok: boolean; account?: QwAccount }>(`/qwenwork/accounts/${id}`, fields),
  /** 回填手机号（对加这个字段之前登录的账号补一次） */
  refreshPhone: () =>
    client.post<{ ok: boolean; results: Array<{ id: number; name: string; ok: boolean; phone?: string; error?: string }> }>(
      '/qwenwork/accounts/refresh-phone',
    ),
}
