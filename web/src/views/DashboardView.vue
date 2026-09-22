<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-lg font-medium m-0">仪表盘</h2>
        <div class="text-xs text-slate-500 mt-1">
          账号池健康度、上游状态与今日用量总览
          <template v-if="lastRefresh"> · 更新于 {{ lastRefresh }}</template>
        </div>
      </div>
      <a-button size="small" :loading="loading" @click="refresh(true)">刷新</a-button>
    </div>

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
          <a-statistic title="有效期内" :value="dash?.summary.valid ?? '—'" value-style="color:#52c41a">
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
            :value-style="dash && dash.summary.expiring_soon > 0 ? 'color:#faad14' : ''"
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
          <a-statistic title="今日 Token" :value="todayTokensText" value-style="color:#1677ff" />
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
          <div v-else ref="chartEl" style="height: 220px"></div>
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
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import client from '@/api/client'
import type { SystemStatus } from '@/api/system'
import type { PointsData, AccountsData } from '@/api/points'
import type { StatsSummary, DailyRow } from '@/api/stats'

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

const chartEl = ref<HTMLElement | null>(null)
let chartInst: echarts.ECharts | null = null

// 请求数与 Token 放同一张图：两者趋势不同步时（请求少但 Token 高）
// 单看一条线会以为流量正常，双轴才能看出真正的负载变化。
function renderChart() {
  if (!chartEl.value) return
  if (!chartInst) chartInst = echarts.init(chartEl.value)

  const rows = daily.value
  chartInst.setOption({
    grid: { left: 48, right: 48, top: 32, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: number) => (v == null ? '—' : v.toLocaleString('zh-CN')),
    },
    legend: { data: ['请求数', 'Token'], right: 0, top: 0, itemWidth: 12, itemHeight: 8 },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.day.slice(5)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisLabel: { color: '#94a3b8', fontSize: 11 },
    },
    yAxis: [
      {
        type: 'value', name: '请求', nameTextStyle: { color: '#94a3b8', fontSize: 11 },
        axisLabel: { color: '#94a3b8', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      {
        type: 'value', name: 'Token', nameTextStyle: { color: '#94a3b8', fontSize: 11 },
        axisLabel: {
          color: '#94a3b8', fontSize: 11,
          formatter: (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v),
        },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '请求数', type: 'line', smooth: true, symbol: 'none',
        data: rows.map((r) => r.requests),
        lineStyle: { color: '#fa8c16', width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(250,140,22,0.25)' },
            { offset: 1, color: 'rgba(250,140,22,0.02)' },
          ]),
        },
      },
      {
        name: 'Token', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 1,
        data: rows.map((r) => r.total_tokens),
        lineStyle: { color: '#1677ff', width: 2 },
      },
    ],
  })
}

async function refresh(force = false) {
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

function onResize() { chartInst?.resize() }

onMounted(() => {
  window.addEventListener('resize', onResize)
  refresh()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  chartInst?.dispose()
  chartInst = null
})
</script>
