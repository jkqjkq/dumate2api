export interface ModelEntry {
  name: string
  target: string
  upstream_native: boolean
  exposed: boolean
}

export interface ModelMapData {
  aliases: Record<string, string>
  upstream_models: string[]
  exposed: string[]
  fallback: string
  entries: ModelEntry[]
  defaults: {
    aliases: Record<string, string>
    upstream_models: string[]
    exposed: string[]
  }
}

export interface ProbeResult {
  model: string
  ok: boolean
  status: number
  error: string
}
