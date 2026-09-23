// 请求日志（网关逐条转发的原始记录）
export interface ReqLogRow {
  ts: number
  ms: number
  first_token_ms: number | null
  path: string
  model: string
  mapped_model?: string
  // 上游通道。**历史记录没有这个字段**（分通道之前产生的），
  // 所以是可选的——界面遇到 undefined 显示「—」而不是默认成搭子。
  channel?: 'dumate' | 'qwenwork'
  stream: boolean
  messages: number
  status: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  ip: string
  ua?: string
  key_id: number
  key: string
  error?: string
  upstream?: string
  account?: string
  // 实际扣费：由「请求后余额 - 上一条请求后余额」实测得出，非估算。
  // points_exact=false 表示这条与相邻请求并发，差值里可能混了别人的消耗。
  points_delta?: number
  points_exact?: boolean
}

export interface ReqLogsData {
  rows: ReqLogRow[]
  total: number
  limit: number
  offset: number
  note?: string
}

// 上游计费记录（网页端「积分消费记录」同源）。
// 与网关日志不是一一对应：一次转发可能拆成多笔扣费。
export interface PointsRecord {
  account_id: number
  account: string
  ts: number
  points: number
  conversation: string
  package_id: string
  rowKey?: string
}

export interface PointsAccountSummary {
  id: number
  name: string
  nickname: string
  ok: boolean
  error?: string
  total_count?: number
  consumed_points?: number
}

export interface PointsRecordsData {
  rows: PointsRecord[]
  total: number
  consumed_points: number
  page: number
  limit: number
  days: number
  accounts: PointsAccountSummary[]
  note?: string
}
