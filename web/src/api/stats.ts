export interface StatsSummary {
  today: {
    requests: number
    ok: number
    failed: number
    input_tokens: number
    output_tokens: number
    total_tokens: number
    avg_ms: number
  }
  days: number
  total: {
    requests: number
    ok: number
    failed: number
    total_tokens: number
    avg_ms: number
  }
}

export interface DailyRow {
  day: string
  requests: number
  total_tokens: number
  failed: number
}

export interface ModelRow {
  model: string
  requests: number
  total_tokens: number
  failed: number
}
