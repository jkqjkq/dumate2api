export interface PointsPackage {
  kind: 'subscription' | 'incremental'
  package_type: string
  source: string
  total: number
  used: number
  left: number
  expire_at: number | null
  status: string
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
}

export interface AccountsData {
  accounts: Account[]
  total: number
  active: number
  stale: number
  unknown: number
}
