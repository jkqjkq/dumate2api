// 聊天测试台（管理端内直接试调，走账号池）
export interface ChatLabModel {
  id: string
  kind: 'upstream' | 'alias'
  mapped: string
}

export interface ChatLabModels {
  exposed: ChatLabModel[]
  aliases: ChatLabModel[]
  fallback: string
}

export interface ChatLabUsage {
  input: number
  output: number
  total: number
}

export interface ChatLabReply {
  ok: boolean
  model: string
  mapped_model: string
  account: string
  content: string
  reasoning: string
  usage: ChatLabUsage
  // 实测消耗（该账号请求前后余额差）。null = 没测到，不补 0
  cost: number | null
  ms: number
}

export interface ChatLabSessionCost {
  ok: boolean
  balance: number | null
  consumed: number | null
  since?: number
}
