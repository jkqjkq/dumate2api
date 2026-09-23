export interface ApiKey {
  id: number
  name: string
  prefix: string
  created_at: number
  expires_at: number | null
  enabled: boolean
  ip_allowlist: string[]
  model_allowlist: string[]
  /** 通道绑定：'' = 不限；设了就只允许走该通道的模型 */
  channel?: '' | 'dumate' | 'qwenwork'
  note: string
  usage: {
    requests: number
    total_tokens: number
    failed: number
    last_at: number
    /** 按通道拆分的用量：同一把 key 可能两条通道都在用 */
    channels?: Record<string, { requests: number; total_tokens: number; failed: number }>
  }
}

export interface KeysData {
  keys: ApiKey[]
  /** 服务端实际应用的通道筛选（'' = 全部） */
  channel?: string
  require_key: boolean
  days: number
}
