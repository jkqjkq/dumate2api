// web/src/api/traework.ts - TRAE Work 通道的接口类型
import client from '@/api/client'

/** 通道状态（/system/status 的 channels.traework） */
export interface TraeworkChannelInfo {
  id: string
  label: string
  kind: 'http' | 'direct'
  ready: boolean
  loggedIn: boolean
  accounts: number
  account: string
  tokenExpiresAt: string | null
  refreshExpiresAt: string | null
  refreshExpired: boolean
  error: string
}

/** 一个 TRAE Work 账号（脱敏：refreshToken 只给尾部） */
export interface TraeworkAccount {
  id: number
  uid: string
  nickname: string
  email: string
  enabled: boolean
  expiresAt: number | null
  refreshExpiresAt: number | null
  credits: number | null
  lastCheckin: number | null
  lastError: string
  deviceId: string
  refreshTail: string
  /**
   * 脱敏手机号。可能为空——TRAE 无官方手机号接口（GetUserInfo 已 401），
   * 仅当昵称形如「用户13800138000」时才能取到。
   */
  phone: string
  /** 手机号来源。为空表示取不到 */
  phoneSource: string
}

export interface TraeworkStatus {
  ready: boolean
  error: string
  accounts: number
  /** multi = 凭证自持，可多账号增删；与千问的 single 不同 */
  mode: 'multi' | 'single'
  modeNote: string
  rows: TraeworkAccount[]
}

export interface TraeworkCreditRow {
  id: number
  nickname: string
  uid: string
  credits: number | null
  checkedIn: boolean | null
  /** 额度接口的实时剩余值 = 总额 − 已消耗。取不到为 null（不补 0） */
  remain: number | null
  limit: number | null
  /** 已消耗（usage_summary.consumed_amount），取不到为 null */
  consumed: number | null
  /** 签到可得的额度（不是余额），来自 status 接口 */
  checkinCredits: number | null
  /** 签到额外赠送，如连续签到奖励 */
  checkinExtra: number | null
  lastCheckin: number | null
  error: string
}

/** 一个 TRAE Work 模型（上游下发，含消耗倍率） */
export interface TraeworkModel {
  id: string
  name: string
  prefixed: string
  /** 消耗倍率（相对值）。接口不给时为 null——显示 —，补 0 会被读成免费 */
  rate: number | null
  /** 折扣前倍率 */
  rateOriginal: number | null
  /** 会员折后倍率 */
  rateDiscounted: number | null
  /** 折扣力度（如 50 = 5 折） */
  memberDiscount: number | null
  /** 本账号是否命中会员折扣 */
  discountMatched: boolean
  contextWindow: number | null
  maxTokens: number | null
  promptMaxTokens: number | null
  capability: string
  multimodal: boolean
  isBeta: boolean
  isNew: boolean
  isDefault: boolean
  /** 客户端可见性：false 的多是内部模型（子代理 / 压缩用） */
  visible: boolean
  usage: string
}

export const traeworkApi = {
  status: () => client.get<TraeworkStatus>('/traework/status'),
  models: (opts: { visibleOnly?: boolean; refresh?: boolean } = {}) => {
    const q: string[] = []
    if (opts.visibleOnly) q.push('visible=1')
    if (opts.refresh) q.push('refresh=1')
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<{
      models: TraeworkModel[]
      total: number
      error: string
      fetchedAt: number
      rateNote: string
    }>(`/traework/models${qs}`)
  },
  credits: () => client.get<{ count: number; rows: TraeworkCreditRow[] }>('/traework/credits'),
  checkin: (id?: number) => client.post('/traework/checkin', id ? { id } : {}),
  loginUrl: () => client.post<{ ok: boolean; url: string; deviceId: string; machineId: string; hint: string }>('/traework/login/url'),
  loginCallback: (payload: { callback: string; deviceId: string; machineId: string }) =>
    client.post<{ ok: boolean; account?: TraeworkAccount; error?: string }>('/traework/login/callback', payload),
  removeAccount: (id: number) => client.delete(`/traework/accounts/${id}`),
  patchAccount: (id: number, fields: { enabled?: boolean }) =>
    client.patch(`/traework/accounts/${id}`, fields),
  /** 回填手机号（从昵称抽；TRAE 无官方手机号接口，多数情况抽不到） */
  refreshPhone: () =>
    client.post<{
      ok: boolean
      results: Array<{ id: number; name: string; ok: boolean; phone?: string; error?: string }>
      note: string
    }>('/traework/accounts/refresh-phone'),
}
