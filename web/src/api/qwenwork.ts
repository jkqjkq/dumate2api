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
   * 每日上限。**接口不返回上限**（实测 /user/wallets 只有余额、无 limit/quota
   * 字段），所以这里恒为 null——不拿配置值反推，那是个会随政策失效的数字。
   */
  limit: number | null
  limitSource: 'unavailable'
  /** 同上：无法给出「已用/上限」进度，故为 null */
  freeUsed: number | null
  expiring: Array<{ balance: number; valid_to: string }>
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

export const qwenworkApi = {
  credits: () => client.get<QwCredits>('/qwenwork/credits'),
  daily: (days = 14) => client.get<{ days: number; rows: QwDailyRow[] }>(`/qwenwork/credits/daily?days=${days}`),
  models: () => client.get<{ models: QwModel[]; error: string }>('/qwenwork/models'),
}
