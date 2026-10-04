// web/src/api/ccswitch.ts - 「配置到 cc-switch」的接口封装
//
// 后端按「所选模型的最小值」推导上下文与输出上限，并把每个数的来源
// （upstream 上游下发 / measured 本项目实测 / config 本地配置）一并返回，
// 界面直接展示依据——不显示一个没有来历的数字。
import client from './client'

export interface CcModel {
  id: string
  prefixed: string
  name: string
  rate: number | null
  contextWindow: number | null
  /** 实测区间的下界（搭子有：声明 192K 但 32K 级才实测通过） */
  contextWindowMin: number | null
  contextSource: string
  maxTokens: number | null
  maxTokensSource: string
  picked?: boolean
}

export interface CcDerived {
  context_window: number | null
  context_source: string
  context_owner: string
  context_note: string
  compact_limit: number | null
  max_output: number | null
  max_output_source: string
  max_output_owner: string
  rule: string
  notes: string[]
}

export interface CcPreview {
  ok: boolean
  channel: string
  channel_label: string
  app: string
  gateway: string
  all_models: CcModel[]
  tiers: (CcModel & { tier: string })[]
  derived: CcDerived
  claude_env: Record<string, string>
  codex_config: string
  codex_catalog: unknown[]
  warnings: string[]
}

export interface CcApplyResult {
  ok: boolean
  /** 检测到 cc-switch 装了没（判据是它的库存在） */
  installed?: boolean
  /** 写入时它是否在运行 */
  running?: boolean
  /** 在运行时写库 → 它内存里没有这条记录，需要重启才显示 */
  need_manual_restart?: boolean
  message?: string
  provider_id?: string
  provider_name?: string
  id?: string
  name?: string
  updated?: boolean
  backup?: string
  /** 写完后是否顺手把它启动了（只在它原本没运行时） */
  started?: boolean
  account_note?: string
  error?: string
}

export const ccswitchApi = {
  preview(params: { channel: string; app: string; models?: string[]; token?: string }) {
    const q = new URLSearchParams({ channel: params.channel, app: params.app })
    if (params.models && params.models.length) q.set('models', params.models.join(','))
    if (params.token) q.set('token', params.token)
    return client.get<CcPreview>(`/cc-switch/preview?${q.toString()}`)
  },

  /** 直接把配置写进 cc-switch（不是生成文本让用户粘） */
  apply(params: { channel: string; app: string; models?: string[]; token?: string; confirmed?: boolean }) {
    return client.post<CcApplyResult>('/cc-switch/apply', params)
  },
}
