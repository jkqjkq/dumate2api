export interface ActivityRecord {
  ts: number
  type: 'checkin' | 'task' | 'draw'
  account_id: number
  account: string
  ok: boolean
  // checkin
  result?: string
  total_times?: number
  // task
  task_id?: number
  title?: string
  via?: string
  already?: boolean
  // draw
  prize?: string
  prize_type?: string
  prize_value?: number
  count?: number
  error?: string
  // 积分变化：差值 + 前后余额，三个都要——差值说明发了多少，
  // 前后值说明从多少变到多少（0 → 30 是首次发放，26 → 56 是累加）
  points_delta?: number | null
  points_before?: number | null
  points_after?: number | null
  total_points?: number
}

export interface DailySummary {
  account_id: number
  account: string
  days: Record<string, Record<string, number>>
  counts: Record<string, number>
}

export interface RecordsData {
  rows: ActivityRecord[]
  total: number
  days: number
  daily: DailySummary[]
  types: Record<string, string>
}

export interface CheckinCalendarAccount {
  account_id: number
  name: string
  nickname: string
  ok: boolean
  error: string
  has_issued_today: boolean | null
  total_times: number | null
  sign_in_days: string[]
}

export interface CheckinCalendarData {
  accounts: CheckinCalendarAccount[]
  months: number
}
