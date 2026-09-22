export interface UsageToday {
  requests: number
  tokens: number
  failed: number
  success_rate: number | null
  avg_ms: number | null
  // 老日志没有首字字段，样本数说明这个均值基于多少条记录
  avg_first_token_ms: number | null
  first_token_samples: number
  input_tokens: number
  output_tokens: number
  stream_count: number
  models: Array<{ model: string; tokens: number }>
  consumed_points: number
  point_records: number
}

export interface UsageCards {
  today: UsageToday
  week: { requests: number; tokens: number; failed: number }
  consumed: number
  consumed_records: number
  active_keys: number
  top_model: string | null
}

export interface UsageDaily {
  day: string
  requests: number
  total_tokens: number
  failed: number
}

export interface UsageBucket {
  requests: number
  total_tokens: number
  input_tokens: number
  output_tokens: number
  failed: number
  avg_ms: number
}

export interface UsageByModel extends UsageBucket {
  model: string
}

export interface UsageByKey extends UsageBucket {
  name: string
}

export interface UsagePointsAccount {
  id: number
  name: string
  ok: boolean
  consumed_points?: number
  count?: number
  error?: string
}

export interface UsageOverview {
  days: number
  cards: UsageCards
  daily: UsageDaily[]
  by_model: UsageByModel[]
  by_key: UsageByKey[]
  points_by_account: UsagePointsAccount[]
  note: string
}
