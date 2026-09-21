export interface ApiKey {
  id: number
  name: string
  prefix: string
  created_at: number
  expires_at: number | null
  enabled: boolean
  ip_allowlist: string[]
  model_allowlist: string[]
  note: string
  usage: {
    requests: number
    total_tokens: number
    failed: number
    last_at: number
  }
}

export interface KeysData {
  keys: ApiKey[]
  require_key: boolean
  days: number
}
