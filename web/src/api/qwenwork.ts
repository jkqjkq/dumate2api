// web/src/api/qwenwork.ts - 千问办公通道的接口类型
import client from '@/api/client'

export interface QwCredits {
  ok: boolean
  error: string
  /** 免费额度余额（每日 00:00 重置） */
  free: number
  /** 付费余额 = monthly + longterm */
  paid: number
  monthly: number
  longterm: number
  total: number
  /** 每日上限。**来自配置而非接口**，前端必须标注来源 */
  limit: number
  limitSource: 'config'
  freeUsed: number
  expiring: Array<{ balance: number; valid_to: string }>
  fetchedAt: number
  today: { free: number; paid: number; total: number; requests: number }
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
