export interface CookieSummary {
  has_bduss: boolean
  has_stoken: boolean
  has_ptoken: boolean
  bduss_tail: string
  baiduid: string
}

export interface WebAccount {
  id: number
  name: string
  created_at: number
  updated_at: number
  enabled: boolean
  uid: string
  nickname: string
  last_login_ok_at: number | null
  last_error: string
  checkin: {
    last_at: number | null
    last_result: string
    total_times: number | null
    sign_in_days: string[]
    month_points: number | null
  }
  lottery: {
    remaining: number | null
    last_at: number | null
    last_result: string
    my_prizes: any[]
  }
  points: { left: number; total: number; used: number } | null
  points_at: number | null
  cookie_len: number
  cookie_summary: CookieSummary
}

export interface LoginUrlInfo {
  url: string
  steps: string[]
  note: string
}

export interface AccountStatus {
  id: number
  name: string
  expired: boolean
  checkin: {
    has_issued?: boolean
    total_times?: number | null
    sign_in_days?: string[]
    month_points?: number | null
    error?: string
  }
  lottery: {
    remaining_draws?: number
    prizes?: any[]
    my_prizes?: any[]
    winning_records?: any[]
    error?: string
  }
  points: {
    left?: number
    total?: number
    used?: number
    subscribed?: boolean
    throttled?: boolean
    packages?: any[]
    error?: string
  }
  tasks: any[] | { error: string }
}

export interface CheckinResult {
  id: number
  name: string
  ok: boolean
  already?: boolean
  error?: string
  expired?: boolean
}

export interface PoolAccount {
  id: number
  name: string
  nickname: string
  enabled: boolean
  last_error: string
  points: number | null
  checkin_result: string
}

/** 任务执行历史的一条（来自 data/task-runs.jsonl） */
export interface TaskRunRow {
  ts: number
  account_id: number
  account: string
  task_id?: string | number
  title: string
  ok: boolean
  /** 怎么跑的：query-then-complete=发消息+上报 / complete-only=仅上报 / noop=无事可做 */
  via?: string
  task_type?: string
  /** 总耗时（毫秒） */
  ms?: number | null
  /** 其中发消息的耗时；QUERY_INPUT 任务的大头 */
  model_ms?: number | null
  /** 真实积分变化（余额差实测）。负数=发消息消耗，正数=奖励到账 */
  points_delta?: number | null
  points_before?: number | null
  points_after?: number | null
  /** 任务定义声明的奖励，与实际到账对照 */
  expected_points?: number | null
  error?: string
  noop?: boolean
}

export interface PoolData {
  gateway_port: number
  gateway_online: boolean
  health: {
    accounts_total: number
    accounts_ready: number
    accounts: Array<{
      name: string
      enabled: boolean
      cooling: boolean
      token_expires_in_s: number | null
    }>
  } | null
  accounts: PoolAccount[]
}
