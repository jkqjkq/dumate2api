// web/src/stores/channel.ts - 全局通道切换
//
// 项目有两个上游通道（搭子 / 千问办公），后续还可能加。这个 store 管
// 「当前在看哪个通道」，各页面据此决定显示什么、请求哪个接口。
//
// 为什么是全局状态而不是各页面各存一份：切换通道是**跨页面的上下文**——
// 在仪表盘切到千问，进请求日志也该是千问。各页自存会出现「仪表盘看千问、
// 日志看搭子」这种自相矛盾的状态。
//
// 选择持久化到 localStorage：刷新后保持，否则每次刷新都跳回搭子。
import { reactive, computed } from 'vue'
import client from '@/api/client'

export interface ChannelInfo {
  id: string
  label: string
  kind: 'http' | 'direct'
  ready: boolean
  port?: number | null
  managed?: boolean
  wasm?: string | null
  loggedIn?: boolean
  error?: string
  account?: string
  tier?: string
  tokenExpiresAt?: string | null
  refreshExpiresAt?: string | null
  refreshExpired?: boolean
}

const STORAGE_KEY = 'lab-channel'

// 通道定义。新增通道只需在这里加一条 + 后端 channels 里报出来。
// menuKeys 是该通道**有意义**的菜单：搭子有账号池/积分/密钥，千问没有——
// 与其让用户点进去看到一片空，不如直接隐藏。
export const CHANNELS = [
  {
    id: 'dumate',
    label: '百度搭子',
    menuKeys: ['dashboard', 'chatlab', 'usage', 'reqlogs', 'models', 'keys', 'account', 'points', 'web-accounts', 'records'],
  },
  {
    id: 'qwenwork',
    label: '千问办公',
    menuKeys: ['dashboard', 'chatlab', 'usage', 'reqlogs', 'models'],
  },
] as const

function initial(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && CHANNELS.some((c) => c.id === saved)) return saved
  } catch {
    /* localStorage 不可用（隐私模式）时用默认值 */
  }
  return 'dumate'
}

export const channelStore = reactive({
  current: initial(),
  // 后端报回的通道状态（含就绪、wasm 版本、登录态到期）
  infos: {} as Record<string, ChannelInfo>,
  loaded: false,

  set(id: string) {
    if (!CHANNELS.some((c) => c.id === id)) return
    this.current = id
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* 存不下也不影响本次会话 */
    }
  },

  async load() {
    try {
      const { data } = await client.get('/system/status')
      this.infos = data?.channels || {}
      this.loaded = true
    } catch {
      // 状态拉不到不影响切换本身，只是徽标不显示
      this.loaded = false
    }
    return this.infos
  },

  /** 当前通道的菜单白名单 */
  menuKeys(): readonly string[] {
    const c = CHANNELS.find((x) => x.id === this.current)
    return c ? c.menuKeys : CHANNELS[0].menuKeys
  },

  info(): ChannelInfo | null {
    return this.infos[this.current] || null
  },

  /** 通道是否可用（用于顶栏徽标着色） */
  ready(): boolean {
    const i = this.info()
    return !!i && i.ready
  },

  /** 该通道是否有需要提醒的问题（就绪但登录态将失效，或未就绪） */
  warning(): string {
    const i = this.info()
    if (!i) return ''
    if (!i.ready) return i.error || '通道不可用'
    if (i.refreshExpired) return 'refresh token 已过期，需重开客户端登录'
    return ''
  },
})

export const currentChannel = computed(() => channelStore.current)
