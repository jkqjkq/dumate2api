export interface UsageCards {
  today: { requests: number; tokens: number; failed: number; consumed_points: number; point_records: number }
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
