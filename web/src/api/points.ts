export interface PointsPackage {
  kind: 'subscription' | 'incremental'
  package_type: string
  source: string
  total: number
  used: number
  left: number
  granted_at: number | null
  expire_at: number | null
  status: string
}

export interface SourceRow {
  source: string
  count: number
  total: number
  used: number
  left: number
  first_at: number | null
  last_at: number | null
  active_days: number
  days_since_last: number | null
}

export interface DailyGrantRow {
  day: string
  granted: number
  used: number
  count: number
}

export interface PointsData {
  subscribed: boolean
  total: number
  used: number
  left: number
  has_remaining: boolean | null
  throttled: boolean
  throttle_reason: string
  packages: PointsPackage[]
  expiring: PointsPackage[]
  sources: SourceRow[]
  daily_grant: DailyGrantRow[]
  expired_unused: PointsPackage[]
  upstream_port: number
  fetched_at: number
  cached?: boolean
}

export interface Account {
  name: string
  user_id: string
  last_login: number
  age_days: number | null
  state: 'active' | 'stale' | 'unknown'
  has_credentials: boolean
  active: boolean
  points: { left: number; total: number; used: number } | null
  points_note: string
  // 网页端凭证（签到/抽奖/积分用）。null = 未在账号管理里添加。
  web: {
    id: number
    name: string
    enabled: boolean
    has_error: boolean
    last_error: string
    checkin_result: string
    points: number | null
  } | null
}

export interface AccountsData {
  accounts: Account[]
  total: number
  active: number
  stale: number
  unknown: number
}
