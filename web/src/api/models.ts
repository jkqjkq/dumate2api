export interface ModelEntry {
  name: string
  target: string
  upstream_native: boolean
  exposed: boolean
}

export interface ChannelModel {
  id: string
  name: string
  prefixed?: string
}

export interface ChannelView {
  id: string
  label: string
  editable: boolean
  prefix: string | null
  models: ChannelModel[]
  error?: string
}

export interface ModelMapData {
  aliases: Record<string, string>
  upstream_models: string[]
  exposed: string[]
  fallback: string
  entries: ModelEntry[]
  /** 通道视图：搭子可编辑，千问办公只读（模型表由上游下发） */
  channels?: ChannelView[]
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
