// web/src/api/modelinfo.ts - 三条通道的模型信息（统一形状）
import client from '@/api/client'

/** 字段来源：决定这个数字能不能信 */
export type ModelFieldSource = 'upstream' | 'measured' | 'config'

export interface ModelInfoRow {
  id: string
  name: string
  /** 调用时用的全名（带通道前缀） */
  prefixed: string
  channel: 'dumate' | 'qwenwork' | 'traework' | 'qoder'
  /** 上游原生名字（非别名） */
  native: boolean
  /** 别名指向的目标 */
  target: string
  /** 消耗倍率。**只有 TRAE 的上游给**，其余通道为 null（显示 —，不补 0） */
  rate: number | null
  rateSource: ModelFieldSource | null
  rateOriginal?: number | null
  rateDiscounted?: number | null
  memberDiscount?: number | null
  discountMatched?: boolean
  /** 上下文窗口。拿不到为 null */
  contextWindow: number | null
  /** 实测下限（搭子：32K 通过 / 128K 超时，所以给区间而非单值） */
  contextWindowMin: number | null
  contextSource: ModelFieldSource | null
  contextNote?: string
  /** 输出上限 */
  maxTokens: number | null
  maxTokensSource: ModelFieldSource | null
  capability: string
  multimodal: boolean
  visible?: boolean
  usage?: string
  isDefault?: boolean
  isNew?: boolean
  isBeta?: boolean
  note?: string
}

export const modelInfoApi = {
  list: (opts: { channel?: string; refresh?: boolean } = {}) => {
    const q: string[] = []
    if (opts.channel) q.push(`channel=${opts.channel}`)
    if (opts.refresh) q.push('refresh=1')
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<{
      channel: string
      rows: ModelInfoRow[]
      error?: string
      errors?: Record<string, string>
    }>(`/models/info${qs}`)
  },
}
