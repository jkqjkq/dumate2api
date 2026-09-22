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
