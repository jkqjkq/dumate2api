export interface DiscoveryStep {
  method: string
  port: number
  hit: boolean
}

export interface SystemStatus {
  admin: { port: number; pid: number }
  gateway: {
    port: number
    online: boolean
    upstream_port: number | null
    upstream_managed: boolean
    source: string
  }
  upstream: {
    port: number | null
    managed: boolean
    managed_port: number
    discovery: DiscoveryStep[]
  }
  install: { dir: string; exe_exists: boolean; config_exists: boolean }
  account: { name: string; user_id: string } | null
  versions: { node: string; admin: string }
}
