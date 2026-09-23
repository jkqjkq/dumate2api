<template>
  <div class="page">
    <PageHeader :title="isQw ? '千问办公' : '仪表盘'">
      <template #sub>
        {{ isQw ? '积分额度、登录态与用量总览' : '账号池健康度、上游状态与今日用量总览' }}
        <template v-if="lastRefresh"> · 更新于 {{ lastRefresh }}</template>
      </template>
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="refresh(true)">刷新</a-button>
      </template>
    </PageHeader>

    <!-- 千问办公：积分卡片。它是另一套账——不消耗搭子积分、不进账号池，
         所以整块替换而不是与搭子的指标卡混排。 -->
    <template v-if="isQw">
      <!-- 三个池子平级展示：月度与长期性质不同（订阅套餐 vs 充值赠送），
           不能合并成一张「付费额度」卡。 -->
      <a-row :gutter="[16, 16]">
        <a-col v-for="w in qwWallets" :key="w.id" :span="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic :title="w.label" :value="w.balance ?? '—'" :precision="2"
              :value-style="w.kind === 'free' && (w.balance ?? 0) < 20 ? 'color:#fbbf24' : ''">
              <template #suffix><span class="text-sm text-slate-400">积分</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <a-tag :color="w.kind === 'free' ? 'green' : 'orange'" class="mr-1">
                {{ w.kind === 'free' ? '免费' : '付费' }}
              </a-tag>
              <template v-if="w.resetAt">每天 00:00 重置</template>
              <template v-else>按有效期</template>
            </div>
          </a-card>
        </a-col>

        <a-col :span="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="经本网关消耗" :value="qw?.today.total ?? '—'" :precision="4" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="qw">
                <a-tag :color="qw.today.paid > 0 ? 'orange' : 'green'" class="mr-1">
                  {{ qw.today.paid > 0 ? '含付费' : '全部免费' }}
                </a-tag>
                免费 {{ qw.today.free.toFixed(4) }} · 付费 {{ qw.today.paid.toFixed(4) }}
              </template>
              <span v-else>—</span>
            </div>
            <div v-if="qw?.today.scope === 'gateway'" class="text-xs text-slate-400 mt-1">
              仅统计经本网关的请求；客户端/网页里的对话不计入
            </div>
          </a-card>
        </a-col>
      </a-row>

      <a-row :gutter="[16, 16]" class="mt-4">
        <a-col :span="17">
          <a-card title="积分消耗趋势" :bordered="false" class="h-full">
            <template #extra><span class="text-xs text-slate-400">按天聚合 · 免费与付费分开</span></template>
            <a-empty v-if="!qwDaily.length" description="还没有归因记录" />
            <div v-else ref="qwChartEl" class="qw-chart" />
          </a-card>
        </a-col>
        <a-col :span="7">
          <a-card title="通道状态" :bordered="false" class="h-full">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item label="状态">
                <a-tag :color="qwInfo?.ready ? (qwInfo.refreshExpired ? 'orange' : 'green') : 'red'">
                  {{ qwInfo?.ready ? (qwInfo.refreshExpired ? '可用·待重登' : '正常') : '不可用' }}
                </a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="wasm">
                <span class="font-mono text-xs">{{ qwInfo?.wasm || '—' }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="账号">
                {{ qwInfo?.account || '—' }}
                <span v-if="qwInfo?.tier" class="text-xs text-slate-400 ml-1">{{ qwInfo.tier }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="access token">
                <span class="font-mono text-xs">{{ fmtExpire(qwInfo?.tokenExpiresAt) }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="refresh token">
                <span class="font-mono text-xs">{{ fmtExpire(qwInfo?.refreshExpiresAt) }}</span>
                <a-tag v-if="qwInfo?.refreshExpired" color="orange" class="ml-1">已过期</a-tag>
              </a-descriptions-item>
            </a-descriptions>
            <a-alert
              v-if="qwInfo?.refreshExpired"
              type="warning"
              show-icon
              class="mt-3"
              message="refresh token 已过期"
              description="access token 到期后需打开千问办公客户端重新登录一次，否则通道会失效。"
            />
          </a-card>
        </a-col>
      </a-row>
    </template>

    <!-- 搭子通道：账号池 + 用量 -->
    <template v-else>
    <!-- 顶部指标卡：数据来自 /web-accounts/dashboard（账号池）+ /stats（用量） -->
    <a-row :gutter="[16, 16]">
      <a-col :span="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="账号总数" :value="dash?.summary.total ?? '—'">
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dash">
              启用 {{ dash.summary.enabled }} · 停用 {{ dash.summary.disabled }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="有效期内" :value="dash?.summary.valid ?? '—'" value-style="color:#34d399">
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dash">
              {{ dash.summary.valid === dash.summary.enabled ? '全部正常' : `${dash.summary.enabled - dash.summary.valid} 个待处理` }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic
            title="即将过期"
            :value="dash?.summary.expiring_soon ?? '—'"
            :value-style="dash && dash.summary.expiring_soon > 0 ? 'color:#fbbf24' : ''"
          >
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            {{ dash && dash.summary.expiring_soon > 0 ? '7 天内到期' : '暂无风险' }}
          </div>
        </a-card>
      </a-col>

      <a-col :span="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="积分余额" :value="dash ? dash.summary.points_left : '—'" :precision="2" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dash">
              <a-tag v-if="dash.summary.low_points" color="orange">
                {{ dash.summary.low_points }} 个低于 200
              </a-tag>
              <span v-else>{{ dash.summary.total }} 个账号合计</span>
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="4">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="今日 Token" :value="todayTokensText" value-style="color:#22d3ee" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="stats">{{ stats.today.requests }} 次请求</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <!-- 趋势 + 上游状态 -->
    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="17">
        <a-card title="近 14 天调用趋势" :bordered="false" class="h-full">
          <a-empty v-if="!daily.length" description="还没有请求记录" />
          <!-- 请求数与 Token 拆成上下两张共享 X 轴的小图，而不是叠在一张图上用双 Y 轴：
               两个量纲的刻度对齐点是任意的，共图会凭空造出「此消彼长」的相关性。
               小倍数保留「同一时间轴上看两条趋势」的能力，又不需要读者在两套刻度间换算。 -->
          <template v-else>
            <div class="trend-block">
              <div class="trend-label">请求数</div>
              <div ref="reqChartEl" class="trend-chart" />
            </div>
            <div class="trend-block">
              <div class="trend-label">Token</div>
              <div ref="tokChartEl" class="trend-chart" />
            </div>
          </template>
        </a-card>
      </a-col>

      <a-col :span="7">
        <a-card title="上游状态" :bordered="false" class="h-full">
          <a-descriptions :column="1" size="small">
            <a-descriptions-item label="网关">
              <a-tag :color="dash?.upstream.gateway_online ? 'green' : 'red'">
                {{ dash?.upstream.gateway_online ? '正常' : '未启动' }}
              </a-tag>
              <span class="text-xs text-slate-400 ml-1">:{{ dash?.upstream.gateway_port ?? 9084 }}</span>
            </a-descriptions-item>
            <a-descriptions-item label="可用账号">
              <template v-if="dash?.upstream.accounts_ready !== null && dash?.upstream.accounts_ready !== undefined">
                {{ dash.upstream.accounts_ready }} / {{ dash.upstream.accounts_total }}
              </template>
              <span v-else class="text-slate-400">—</span>
            </a-descriptions-item>
            <a-descriptions-item label="冷却中">
              <template v-if="dash?.upstream.cooling !== null && dash?.upstream.cooling !== undefined">
                {{ dash.upstream.cooling }}
              </template>
              <span v-else class="text-slate-400">—</span>
            </a-descriptions-item>
            <a-descriptions-item label="本地代理">
              <a-tag :color="status?.gateway.online ? 'green' : 'red'">
                {{ status?.gateway.online ? '在线' : '离线' }}
              </a-tag>
              <span class="text-xs text-slate-400 ml-1">:{{ status?.gateway.port ?? 9080 }}</span>
            </a-descriptions-item>
            <a-descriptions-item label="上游端口">
              {{ status?.upstream.port ?? '—' }}
              <a-tag v-if="status?.upstream.managed" color="blue" class="ml-1">自建</a-tag>
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>
    </a-row>

    <!-- 账号健康快照 -->
    <a-card :bordered="false" class="mt-4">
      <template #title>
        <span>账号健康快照</span>
        <a-tag v-if="dash" color="green" class="ml-2">在线 {{ dash.summary.valid }}</a-tag>
      </template>
      <a-empty v-if="!dash?.accounts.length" description="还没有添加账号" />
      <a-row v-else :gutter="[16, 16]">
        <a-col v-for="a in dash.accounts" :key="a.id" :span="8">
          <div class="p-3 border border-slate-200 rounded">
            <div class="flex items-center justify-between mb-2">
              <span class="font-medium">{{ a.nickname || a.name }}</span>
              <a-tag :color="a.last_error ? 'red' : a.enabled ? 'green' : 'default'">
                {{ a.last_error ? '异常' : a.enabled ? '在线' : '停用' }}
              </a-tag>
            </div>
            <!-- 健康条：长度按会员剩余天数，30 天为满 -->
            <div class="h-1.5 bg-slate-100 rounded overflow-hidden mb-2">
              <div
                class="h-full rounded transition-all"
                :class="healthColor(a)"
                :style="{ width: healthWidth(a) }"
              />
            </div>
            <div class="flex items-center justify-between text-xs">
              <span class="text-slate-500">
                {{ a.days_left !== null ? a.days_left + ' 天' : '到期未知' }}
              </span>
              <span :class="a.points !== null && a.points < 200 ? 'text-orange-500' : 'text-slate-600'">
                {{ a.points !== null ? fmt(a.points) + ' 积分' : '积分未知' }}
              </span>
            </div>
            <div v-if="a.last_error" class="text-xs text-red-500 mt-1">{{ a.last_error }}</div>
          </div>
        </a-col>
      </a-row>
    </a-card>

    <!-- 用量与账号状态明细 -->
    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="12">
        <a-card title="今日用量" :bordered="false">
          <a-descriptions :column="2" size="small" bordered>
            <a-descriptions-item label="请求数">
              {{ stats ? stats.today.requests : '—' }}
              <a-tag v-if="stats?.today.failed" color="red" class="ml-1">失败 {{ stats.today.failed }}</a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="Token">
              {{ stats ? fmt(stats.today.total_tokens) : '—' }}
            </a-descriptions-item>
            <a-descriptions-item label="输入">{{ stats ? fmt(stats.today.input_tokens) : '—' }}</a-descriptions-item>
            <a-descriptions-item label="输出">{{ stats ? fmt(stats.today.output_tokens) : '—' }}</a-descriptions-item>
            <a-descriptions-item label="平均耗时">
              {{ stats ? stats.today.avg_ms + ' ms' : '—' }}
            </a-descriptions-item>
            <a-descriptions-item :label="`累计 ${stats?.days ?? 30} 天`">
              {{ stats ? fmt(stats.total.total_tokens) + ' tokens' : '—' }}
              <span class="text-xs text-slate-400 ml-1">
                / {{ stats ? stats.total.requests : '—' }} 次
              </span>
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>

      <a-col :span="12">
        <a-card title="本地代理账号" :bordered="false">
          <a-table
            size="small"
            :pagination="false"
            :data-source="accounts?.accounts ?? []"
            :columns="accountColumns"
            row-key="user_id"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'state'">
                <a-tag :color="stateColor(record.state)">{{ stateText(record.state) }}</a-tag>
              </template>
              <template v-else-if="column.key === 'web'">
                <a-tag v-if="record.web" color="green">已添加</a-tag>
                <span v-else class="text-xs text-slate-400">未添加</span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            「本地代理账号」是桌面端凭证（跑模型用），与上面「账号健康快照」的网页凭证是两套。
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-alert v-if="error" type="warning" show-icon class="mt-4" :message="`部分数据获取失败：${error}`" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { channelStore } from '@/stores/channel'
import { qwenworkApi, type QwCredits, type QwDailyRow } from '@/api/qwenwork'
import client from '@/api/client'
import type { SystemStatus } from '@/api/system'
import type { PointsData, AccountsData } from '@/api/points'
import type { StatsSummary, DailyRow } from '@/api/stats'
import { SERIES, INK, TOOLTIP_BASE, axisStyle, compactNum, exactNum, lineSeries } from '@/utils/chartTheme'

interface DashAccount {
  id: number
  name: string
  nickname: string
  enabled: boolean
  points: number | null
  points_total: number | null
  subscribed: boolean
  days_left: number | null
  expire_at: number | null
  checkin_result: string
  last_error: string
}

interface DashData {
  summary: {
    total: number; enabled: number; disabled: number; valid: number
    expiring_soon: number; low_points: number
    points_left: number; points_total: number
  }
  upstream: {
    gateway_online: boolean; gateway_port: number
    accounts_total: number | null; accounts_ready: number | null; cooling: number | null
  }
  accounts: DashAccount[]
}

const status = ref<SystemStatus | null>(null)
const points = ref<PointsData | null>(null)
const accounts = ref<AccountsData | null>(null)
const stats = ref<StatsSummary | null>(null)
const daily = ref<DailyRow[]>([])
const dash = ref<DashData | null>(null)
const loading = ref(false)
const error = ref('')
const lastRefresh = ref('')

// 通道：千问办公是另一套账（积分/登录态），整块内容与搭子不同。
// 用 store 的全局状态而不是本地 ref —— 顶栏切换器与这里必须一致。
const isQw = computed(() => channelStore.current === 'qwenwork')
const qw = ref<QwCredits | null>(null)
const qwDaily = ref<QwDailyRow[]>([])
const qwInfo = computed(() => channelStore.infos['qwenwork'] || null)
// 三个池子。后端平级返回 wallets，前端不再自己合并——「月度」与「长期」
// 一个来自订阅套餐、一个来自充值赠送，合并成一张「付费额度」卡会丢信息。
const qwWallets = computed(() => qw.value?.wallets || [])

function fmtExpire(iso?: string | null) {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

const accountColumns = [
  { title: '账号', key: 'name', dataIndex: 'name' },
  { title: '桌面凭证', key: 'state', width: '20%' },
  { title: '网页凭证', key: 'web', width: '20%' },
]

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const compact = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B'
    : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)

const todayTokensText = computed(() =>
  stats.value ? compact(stats.value.today.total_tokens) : '—')

const stateColor = (s: string) => {
  if (s === 'active') return 'green'
  if (s === 'standby') return 'blue'
  if (s === 'no_credential') return 'orange'
  return 'default'
}
const stateText = (s: string) => {
  if (s === 'active') return '使用中'
  if (s === 'standby') return '备用'
  if (s === 'no_credential') return '无凭证'
  return '未知'
}

// 健康条：按会员剩余天数，30 天为满格。
// 用天数而不是积分——积分随时会被模型消耗，天天在变；到期日是稳定的寿命指标。
function healthWidth(a: DashAccount) {
  if (a.days_left === null) return '0%'
  const pct = Math.max(0, Math.min(100, (a.days_left / 30) * 100))
  return pct + '%'
}
function healthColor(a: DashAccount) {
  if (a.last_error) return 'bg-red-400'
  if (a.days_left === null) return 'bg-slate-300'
  if (a.days_left <= 7) return 'bg-orange-400'
  return 'bg-green-500'
}

// 趋势图用 ECharts 按需引入：只加载折线图需要的模块，
// 比全量引入（约 1MB）小得多，也避免为一个图表拖慢首屏。
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart, GridComponent, TooltipComponent, LegendComponent,
  DataZoomComponent, CanvasRenderer,
])

const reqChartEl = ref<HTMLElement | null>(null)
const tokChartEl = ref<HTMLElement | null>(null)
let reqChart: echarts.ECharts | null = null
let tokChart: echarts.ECharts | null = null

// 两张小倍数图共享同一套 X 轴刻度与 grid，纵向对齐后可以当作一条时间轴来读。
// 拆开而不是双 Y 轴：双轴的刻度对齐点没有依据，会让人读出并不存在的相关性。
function renderChart() {
  const rows = daily.value
  const days = rows.map((r) => r.day.slice(5))
  // 共享的 X 轴配置：只在下面那张显示标签，避免重复占用垂直空间
  const baseGrid = { left: 56, right: 16, top: 8, bottom: 4 }
  const xAxisCommon = {
    type: 'category' as const,
    data: days,
    boundaryGap: false,
    axisLine: { show: true, lineStyle: { color: INK.axis } },
    axisTick: { show: false },
  }
  const tooltipCommon = {
    ...TOOLTIP_BASE,
    trigger: 'axis' as const,
    axisPointer: {
      type: 'line' as const,
      lineStyle: { color: INK.axis, width: 1 },
    },
  }

  if (reqChartEl.value) {
    if (!reqChart) reqChart = echarts.init(reqChartEl.value)
    reqChart.setOption({
      grid: baseGrid,
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any[]) => {
          const r = rows[params[0].dataIndex]
          return `${r.day}<br/>请求 <b>${exactNum(r.requests)}</b>`
        },
      },
      xAxis: { ...xAxisCommon, axisLabel: { show: false } },
      yAxis: {
        type: 'value',
        ...axisStyle({ formatter: (v: number) => compactNum(v) }),
      },
      series: [
        lineSeries({
          name: '请求数',
          data: rows.map((r) => r.requests),
          color: SERIES[0],
          area: true,
        }),
      ],
    })
  }

  if (tokChartEl.value) {
    if (!tokChart) tokChart = echarts.init(tokChartEl.value)
    tokChart.setOption({
      grid: { ...baseGrid, bottom: 22 },
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any[]) => {
          const r = rows[params[0].dataIndex]
          return `${r.day}<br/>Token <b>${exactNum(r.total_tokens)}</b>`
        },
      },
      xAxis: { ...xAxisCommon, axisLabel: { color: INK.muted, fontSize: 11 } },
      yAxis: {
        type: 'value',
        ...axisStyle({ formatter: (v: number) => compactNum(v) }),
      },
      series: [
        lineSeries({
          name: 'Token',
          data: rows.map((r) => r.total_tokens),
          color: SERIES[1],
          area: true,
        }),
      ],
    })
  }
}

// 千问办公的数据单独拉：它走的是 /qwenwork/* 而不是搭子那套接口，
// 两者混在一个 Promise.all 里会让任一通道故障拖垮整页。
async function refreshQw() {
  loading.value = true
  error.value = ''
  try {
    const [c, d] = await Promise.all([
      qwenworkApi.credits(),
      qwenworkApi.daily(14),
    ])
    qw.value = c.data
    qwDaily.value = d.data.rows
    await channelStore.load()
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    await nextTick()
    renderQwChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

async function refresh(force = false) {
  if (isQw.value) return refreshQw()
  loading.value = true
  error.value = ''
  try {
    const [s, p, a, st, dy, db] = await Promise.all([
      client.get('/system/status'),
      client.get('/points/points' + (force ? '?refresh=1' : '')),
      client.get('/points/accounts'),
      client.get('/stats/summary'),
      client.get('/stats/daily?days=14'),
      client.get('/web-accounts/dashboard'),
    ])
    status.value = s.data
    points.value = p.data
    accounts.value = a.data
    stats.value = st.data
    daily.value = dy.data.rows
    dash.value = db.data
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    // 等 DOM 更新后再渲染，否则 ref 还没挂上
    await nextTick()
    renderChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

// 千问积分趋势：免费与付费堆叠。分开画是因为「消耗的是免费额度还是
// 付费额度」是本通道最要紧的一件事——堆叠能一眼看出付费是否开始被动用。
const qwChartEl = ref<HTMLElement | null>(null)
let qwChart: echarts.ECharts | null = null

function renderQwChart() {
  const rows = qwDaily.value
  if (!qwChartEl.value || !rows.length) return
  if (!qwChart) qwChart = echarts.init(qwChartEl.value)
  const days = rows.map((r) => r.day.slice(5))
  qwChart.setOption({
    grid: { left: 56, right: 16, top: 12, bottom: 24 },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      formatter: (params: any[]) => {
        const r = rows[params[0].dataIndex]
        return `${r.day}<br/>免费 <b>${exactNum(r.free)}</b><br/>付费 <b>${exactNum(r.paid)}</b><br/>请求 ${exactNum(r.requests)} 次`
      },
    },
    legend: { data: ['免费额度', '付费额度'], right: 0, top: 0, textStyle: { color: INK.secondary, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
    xAxis: { type: 'category', data: days, boundaryGap: false, axisLine: { show: true, lineStyle: { color: INK.axis } }, axisTick: { show: false }, axisLabel: { color: INK.muted, fontSize: 11 } },
    // 积分量级很小（单次请求 0.0025~0.02），compactNum 会把刻度全取整成
    // 1/0，看不出差别——这里用小数位而不是紧凑格式。
    yAxis: { type: 'value', ...axisStyle({ formatter: (v: number) => (v === 0 ? '0' : v.toFixed(2)) }) },
    series: [
      { ...lineSeries({ name: '免费额度', data: rows.map((r) => r.free), color: SERIES[2], area: true }), stack: 'credit' },
      { ...lineSeries({ name: '付费额度', data: rows.map((r) => r.paid), color: SERIES[1], area: true }), stack: 'credit' },
    ],
  })
}

function onResize() {
  reqChart?.resize()
  tokChart?.resize()
  qwChart?.resize()
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  refresh()
})

// 切通道要重拉数据：两个通道的数据源不同，不重拉会看到上一个通道的残留
watch(isQw, () => { refresh() })

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  reqChart?.dispose()
  tokChart?.dispose()
  qwChart?.dispose()
  reqChart = null
  tokChart = null
  qwChart = null
})
</script>

<style scoped>
.qw-chart {
  height: 260px;
  width: 100%;
}
/* 两张小倍数图：上下贴紧、共享一条时间轴，读起来仍是一条趋势带 */
.trend-block + .trend-block {
  margin-top: 2px;
}
.trend-label {
  font-size: 11px;
  color: var(--lab-text-mute);
  padding-left: 2px;
}
/* 高度含 X 轴标签带，避免容器把轴标签裁掉后卡片里出现内嵌滚动条 */
.trend-chart {
  height: 112px;
  width: 100%;
}
</style>
