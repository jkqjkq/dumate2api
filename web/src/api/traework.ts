// web/src/api/traework.ts - TRAE Work 通道的接口类型
import client from '@/api/client'

/** 一个 TRAE Work 账号（脱敏：refreshToken 只给尾部） */
export interface TraeworkAccount {
  id: number
  uid: string
  nickname: string
  email: string
  enabled: boolean
  expiresAt: number | null
  refreshExpiresAt: number | null
  credits: number | null
  lastCheckin: number | null
  lastError: string
  deviceId: string
  refreshTail: string
}

export interface TraeworkStatus {
  ready: boolean
  error: string
  accounts: number
  /** multi = 凭证自持，可多账号增删；与千问的 single 不同 */
  mode: 'multi' | 'single'
  modeNote: string
  rows: TraeworkAccount[]
}

export interface TraeworkCreditRow {
  id: number
  nickname: string
  uid: string
  credits: number | null
  checkedIn: boolean | null
  /** 额度接口的实时剩余值 */
  remain: number | null
  limit: number | null
  lastCheckin: number | null
  error: string
}

export const traeworkApi = {
  status: () => client.get<TraeworkStatus>('/traework/status'),
  credits: () => client.get<{ count: number; rows: TraeworkCreditRow[] }>('/traework/credits'),
  checkin: (id?: number) => client.post('/traework/checkin', id ? { id } : {}),
  loginUrl: () => client.post<{ ok: boolean; url: string; deviceId: string; machineId: string; hint: string }>('/traework/login/url'),
  loginCallback: (payload: { callback: string; deviceId: string; machineId: string }) =>
    client.post<{ ok: boolean; account?: TraeworkAccount; error?: string }>('/traework/login/callback', payload),
  removeAccount: (id: number) => client.delete(`/traework/accounts/${id}`),
  patchAccount: (id: number, fields: { enabled?: boolean }) =>
    client.patch(`/traework/accounts/${id}`, fields),
}
