<template>
  <div class="page">
    <PageHeader title="积分明细">
      <template #sub>
        <template v-if="loading">加载中…</template>
        <template v-else-if="current">共 {{ accountOptions.length }} 个账号可选</template>
        <template v-else>没有可用数据</template>
      </template>
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load(true)">刷新</a-button>
      </template>
    </PageHeader>

    <!-- 多账号总览：账号管理里添加的每份网页凭证都能独立查积分。
         点行即切换下方明细，避免「看汇总」和「看明细」要操作两次。 -->
    <a-card title="多账号总览" :bordered="false" class="mb-4">
      <template v-if="allPoints && allPoints.accounts.length">
        <a-row :gutter="[16, 16]" class="mb-3">
          <a-col :span="8">
            <a-statistic
              title="账号总余额"
              :value="allPoints.totals.left"
              :precision="2"
            />
            <div class="text-xs text-slate-500 mt-2">
              {{ allPoints.totals.ok_accounts }} / {{ allPoints.totals.accounts }} 个账号取到数据
            </div>
          </a-col>
          <a-col :span="8">
            <a-statistic title="账号总量" :value="allPoints.totals.total" :precision="2" />
          </a-col>
          <a-col :span="8">
            <a-statistic title="账号已用" :value="allPoints.totals.used" :precision="2" />
          </a-col>
        </a-row>

        <a-table
          size="small"
          :pagination="false"
          :data-source="allPoints.accounts"
          :columns="acctColumns"
          row-key="id"
          :row-class-name="rowClass"
          :custom-row="customRow"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <div>{{ record.nickname || record.name }}</div>
              <div v-if="!record.ok" class="text-xs text-red-500">{{ record.error }}</div>
            </template>
            <template v-else-if="column.key === 'left'">
              <span v-if="record.ok" class="font-medium">{{ fmt(record.left) }}</span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'total'">
              {{ record.ok ? fmt(record.total) : '—' }}
            </template>
            <template v-else-if="column.key === 'used'">
              {{ record.ok ? fmt(record.used) : '—' }}
            </template>
            <template v-else-if="column.key === 'state'">
              <a-tag v-if="!record.ok" color="red">失效</a-tag>
              <a-tag v-else-if="record.throttled" color="orange">限流</a-tag>
              <a-tag v-else color="green">正常</a-tag>
            </template>
          </template>
        </a-table>
      </template>
      <a-empty v-else description="还没有添加账号。到「账号管理」里添加后，这里会显示每个账号的积分。" />
    </a-card>

    <!-- 账号切换：下面所有区块都跟随这里选中的账号。
         原先只有一个小 radio 组，切了之后下方变化不明显，容易被读成「没切换成功」，
         所以改成大号分段控件 + 顶部大标题，并把选中行在总览表里同步高亮。 -->
    <a-card :bordered="false" class="mb-4">
      <template #title>
        <span class="text-base font-medium">查看账号</span>
      </template>
      <template #extra>
        <span v-if="detailCached" class="text-xs text-slate-400">本次为缓存数据</span>
      </template>

      <a-radio-group
        v-model:value="selectedId"
        button-style="solid"
        size="large"
        class="w-full flex"
      >
        <a-radio-button
          v-for="o in accountOptions"
          :key="o.key"
          :value="o.key"
          :disabled="!o.ok"
          class="acct-btn flex-1 text-center"
        >
          {{ o.label }}
          <span v-if="!o.ok" class="text-xs opacity-70">（不可用）</span>
        </a-radio-button>
      </a-radio-group>

      <div class="text-xs text-slate-500 mt-2">
        切换账号不会重新请求——每个账号的完整明细已随列表一次性取回。点「刷新」才重新打上游。
      </div>
    </a-card>

    <!-- 当前账号大标题：切换后最先看到的反馈 -->
    <div
      v-if="current"
      class="acct-banner mb-4 flex items-center justify-between flex-wrap gap-2"
    >
      <div class="flex items-center gap-3">
        <span class="text-xs text-slate-500">当前查看</span>
        <span class="text-xl font-semibold text-slate-800">{{ currentLabel }}</span>
        <a-tag v-if="selectedId === 'local'" color="blue">桌面凭证</a-tag>
        <a-tag v-else color="purple">网页凭证</a-tag>
      </div>
      <div class="text-sm text-slate-600">
        余额 <b class="text-base">{{ fmt(current.left) }}</b>
        <span class="text-slate-400 ml-2">共 {{ fmt(current.total) }} · 已用 {{ fmt(current.used) }}</span>
      </div>
    </div>

    <div v-if="!accountOptions.length" class="text-xs text-slate-500 mb-2">
      还没有添加网页账号。到「账号管理」里添加后，可与本地后端账号一起切换查看。
    </div>

    <a-alert v-if="currentError" type="warning" show-icon class="mb-4" :message="`积分获取失败：${currentError}`" />

    <!-- 明细区按账号 key 化：切换时整块重新挂载并淡入，视觉上能确认「换了一份数据」 -->
    <div :key="selectedId" class="detail-block">

    <a-row :gutter="[16, 16]">
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="可用余额" :value="current?.left ?? '—'" :precision="2" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="current">共 {{ fmt(current.total) }} · 已用 {{ fmt(current.used) }}</template>
          </div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="额度包数量" :value="current?.packages?.length ?? '—'" />
          <div class="text-xs text-slate-500 mt-2">订阅 + 增量包</div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic
            title="即将过期"
            :value="current ? (current.expiring?.length ?? 0) : '—'"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="current?.expiring?.length">
              最近 {{ dateText(current.expiring[0].expire_at) }}
            </template>
            <span v-else>没有未用完且临期的额度</span>
          </div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic
            title="已过期未用完"
            :value="current ? (current.expired_unused?.length ?? 0) : '—'"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="current?.expired_unused?.length">
              这部分额度已经用不上了
            </template>
            <span v-else>没有浪费的额度</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-card title="按来源统计" :bordered="false" class="mt-4">
      <a-alert
        type="info"
        show-icon
        class="mb-3"
        message="积分由服务端按天自动发放，没有签到或任务领取接口"
        description="登录奖励（login_bonus）为每日自动发放 500，成长计划奖励（growth_plan_*）由服务端按账号状态发放。客户端只提供查询接口，无手动领取能力。"
      />
      <a-table
        size="small"
        :pagination="false"
        :data-source="current?.sources ?? []"
        :columns="sourceColumns"
        row-key="source"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'">
            <span class="font-mono text-xs">{{ record.source }}</span>
          </template>
          <template v-else-if="column.key === 'num'">
            {{ fmt(record.total) }}
          </template>
          <template v-else-if="column.key === 'used'">
            {{ fmt(record.used) }}
          </template>
          <template v-else-if="column.key === 'left'">
            <span class="font-medium">{{ fmt(record.left) }}</span>
          </template>
          <template v-else-if="column.key === 'last'">
            <template v-if="record.last_at">
              {{ dateText(record.last_at) }}
              <a-tag :color="record.days_since_last === 0 ? 'green' : record.days_since_last > 3 ? 'orange' : 'default'" class="ml-1">
                {{ record.days_since_last === 0 ? '今天' : record.days_since_last + ' 天前' }}
              </a-tag>
            </template>
            <span v-else>—</span>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="每日发放与消耗" :bordered="false" class="mt-4">
      <a-empty v-if="!current?.daily_grant?.length" description="没有发放记录" />
      <!-- 发放与消耗同为「积分」量纲，所以能共图共用一张 Y 轴；
           先前手写的柱状图只画了发放，消耗藏在 title 里要悬停才看得到，
           而「发了多少、用了多少」恰恰是这张图要回答的。 -->
      <div v-else ref="grantChartEl" class="grant-chart" />
    </a-card>

    <a-card title="逐笔发放记录" :bordered="false" class="mt-4">
      <a-table
        size="small"
        :data-source="pkgRows"
        :columns="pkgColumns"
        row-key="rowKey"
        :pagination="{ pageSize: 15, size: 'small', showSizeChanger: false }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'">
            <span class="font-mono text-xs">{{ record.source || record.package_type || '—' }}</span>
          </template>
          <template v-else-if="column.key === 'granted'">
            {{ dateTimeText(record.granted_at) }}
          </template>
          <template v-else-if="column.key === 'expire'">
            {{ dateTimeText(record.expire_at) }}
          </template>
          <template v-else-if="column.key === 'total'">
            {{ fmt(record.total) }}
          </template>
          <template v-else-if="column.key === 'used'">
            {{ fmt(record.used) }}
          </template>
          <template v-else-if="column.key === 'left'">
            <a-tag :color="record.left > 0 ? 'green' : 'default'">{{ fmt(record.left) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="pkgStateColor(record)">{{ pkgStateText(record) }}</a-tag>
          </template>
        </template>
      </a-table>
    </a-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import type { PointsData, PointsPackage, AllPointsData, AccountPoints } from '@/api/points'
import { SERIES, INK, TOOLTIP_BASE, axisStyle, compactNum, exactNum, barSeries } from '@/utils/chartTheme'

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

// 当前展示的账号统一成一份「明细视图」：本地后端与网页账号字段对齐后，
// 下面的统计卡 / 按来源 / 每日发放 / 逐笔四块都只读它，切换账号时整套跟着变。
interface PointsView2 {
  left: number
  total: number
  used: number
  packages: PointsPackage[]
  expiring: PointsPackage[]
  expired_unused: PointsPackage[]
  sources: any[]
  daily_grant: any[]
}

const data = ref<PointsData | null>(null)
const allPoints = ref<AllPointsData | null>(null)
const loading = ref(false)
const error = ref('')
const selectedId = ref<string>('local')

// 可切换的账号：本地后端 + 每个网页账号。取不到数据的也列出来（禁用），
// 否则用户不知道自己有这个账号、只是这次查询失败了。
const accountOptions = computed(() => {
  const opts: Array<{ key: string; label: string; ok: boolean }> = []
  for (const a of allPoints.value?.accounts ?? []) {
    opts.push({ key: String(a.id), label: a.nickname || a.name, ok: !!a.ok })
  }
  opts.push({ key: 'local', label: data.value?.account_name || '本地后端', ok: !!data.value })
  return opts
})

// 选中的账号明细。网页账号的 id 是数字，本地后端固定 'local'。
const current = computed<PointsView2 | null>(() => {
  if (selectedId.value === 'local') {
    const d = data.value
    if (!d) return null
    return {
      left: d.left, total: d.total, used: d.used,
      packages: d.packages, expiring: d.expiring,
      expired_unused: d.expired_unused, sources: d.sources, daily_grant: d.daily_grant,
    }
  }
  const a = (allPoints.value?.accounts ?? []).find((x) => String(x.id) === selectedId.value)
  if (!a || !a.ok) return null
  return {
    left: a.left ?? 0, total: a.total ?? 0, used: a.used ?? 0,
    packages: a.packages ?? [], expiring: a.expiring ?? [],
    expired_unused: a.expired_unused ?? [], sources: a.sources ?? [], daily_grant: a.daily_grant ?? [],
  }
})

// 当前选中的账号查询失败时，把原因显示在当前位置而不是顶部——顶部那一条
// 是留给整体加载失败的，两个来源的错误不该混在一起
const currentError = computed(() => {
  if (selectedId.value === 'local') return error.value
  const a = (allPoints.value?.accounts ?? []).find((x) => String(x.id) === selectedId.value)
  return a && !a.ok ? (a.error || '查询失败') : ''
})

const detailCached = computed(() => {
  if (selectedId.value === 'local') return !!data.value?.cached
  const a = (allPoints.value?.accounts ?? []).find((x) => String(x.id) === selectedId.value)
  return !!a?.cached
})

const currentLabel = computed(() =>
  accountOptions.value.find((o) => o.key === selectedId.value)?.label ?? '—')

// 总览表点行切换下方明细：汇总与明细是同一批账号的两种视图，
// 让用户来回找切换器没有意义
function customRow(record: AccountPoints) {
  return {
    onClick: () => {
      if (record.ok) selectedId.value = String(record.id)
    },
  }
}
function rowClass(record: AccountPoints) {
  return String(record.id) === selectedId.value ? 'row-selected' : ''
}

// 多账号表的列
const acctColumns = [
  { title: '账号', key: 'name' },
  { title: '余额', key: 'left', width: '18%' },
  { title: '总量', key: 'total', width: '16%' },
  { title: '已用', key: 'used', width: '16%' },
  { title: '状态', key: 'state', width: '12%' },
]

const sourceColumns = [
  { title: '来源', key: 'source', width: '26%' },
  { title: '笔数', key: 'count', width: '10%' },
  { title: '发放总额', key: 'num', width: '16%' },
  { title: '已用', key: 'used', width: '16%' },
  { title: '剩余', key: 'left', width: '16%' },
  { title: '最近发放', key: 'last', width: '16%' },
]
const pkgColumns = [
  { title: '来源', key: 'source', width: '22%' },
  { title: '发放时间', key: 'granted', width: '18%' },
  { title: '到期时间', key: 'expire', width: '18%' },
  { title: '总额', key: 'total', width: '12%' },
  { title: '已用', key: 'used', width: '12%' },
  { title: '剩余', key: 'left', width: '10%' },
  { title: '状态', key: 'status', width: '10%' },
]

// 逐笔记录要按发放时间倒序，且补一个稳定的 key（包 ID 可能重复）
const recentDaily = computed(() => (current.value?.daily_grant ?? []).slice(-14))

const pkgRows = computed(() =>
  (current.value?.packages ?? [])
    .slice()
    .sort((a, b) => (b.granted_at || 0) - (a.granted_at || 0))
    .map((p, i) => ({ ...p, rowKey: `${p.source}-${p.granted_at}-${i}` })))

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const dateText = (ts: number | null) =>
  ts ? new Date(ts).toLocaleDateString('zh-CN') : '—'
// 发放/到期时间精确到秒：同一天会发多笔（实测一天 61 笔），只到日期的话
// 逐笔记录里几十行显示完全一样，分不出先后顺序
const dateTimeText = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'

// 每日发放与消耗。两个序列同量纲（积分），共用一个 Y 轴与图例。
function renderGrantChart() {
  if (!grantChartEl.value) return
  if (!grantChart) grantChart = echarts.init(grantChartEl.value)
  const rows = recentDaily.value
  if (!rows.length) return

  grantChart.setOption({
    grid: { left: 60, right: 12, top: 34, bottom: 26 },
    legend: {
      data: ['发放', '消耗'],
      right: 0,
      top: 0,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: INK.secondary, fontSize: 12 },
    },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any[]) => {
        const r = rows[params[0].dataIndex]
        return `<div style="color:${INK.muted};font-size:11px">${r.day}</div>`
          + `<div style="margin-top:2px">发放 <b>${exactNum(r.granted)}</b></div>`
          + `<div>消耗 <b>${exactNum(r.used)}</b></div>`
          + `<div style="color:${INK.muted}">${r.count} 笔</div>`
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.day.slice(5)),
      ...axisStyle({ showGrid: false }),
    },
    yAxis: { type: 'value', ...axisStyle({ formatter: (v: number) => compactNum(v) }) },
    series: [
      barSeries({ name: '发放', data: rows.map((r) => r.granted), color: SERIES[0] }),
      barSeries({ name: '消耗', data: rows.map((r) => r.used), color: SERIES[1] }),
    ],
  })
}

function pkgStateText(p: PointsPackage) {
  if (p.expire_at && p.expire_at < Date.now()) return p.left > 0 ? '已过期(有剩余)' : '已过期'
  if (p.left <= 0) return '已用尽'
  return '可用'
}
function pkgStateColor(p: PointsPackage) {
  if (p.expire_at && p.expire_at < Date.now()) return 'red'
  if (p.left <= 0) return 'default'
  return 'green'
}

async function load(force = false) {
  loading.value = true
  error.value = ''
  try {
    // 多账号（网页凭证）与单账号（本地后端）分别拉：一个失败不影响另一个显示
    try {
      const { data: ap } = await client.get('/web-accounts/points-all' + (force ? '?refresh=1' : ''))
      allPoints.value = ap
    } catch (e) { /* 账号管理没配也不影响下面的明细 */ }

    try {
      const { data: d } = await client.get('/points/points' + (force ? '?refresh=1' : ''))
      data.value = d
    } catch (e: any) {
      // 本地后端起不来时不能把整页判死：网页账号的明细照样要看得到
      error.value = e?.response?.data?.error || e?.message || '未知错误'
    }

    // 首次加载默认选中第一个可用账号（网页账号优先）。之后刷新保留用户选择，
    // 否则每次点刷新都会跳回去，正在对比的账号被切走。
    const valid = accountOptions.value.filter((o) => o.ok).map((o) => o.key)
    if (!valid.includes(selectedId.value)) {
      selectedId.value = valid[0] ?? 'local'
    }
  } finally {
    loading.value = false
  }
}

// 图表实例：切换账号或刷新后要重画，组件卸载要销毁（否则 resize 监听会持有已卸载的实例）
const grantChartEl = ref<HTMLElement | null>(null)
let grantChart: echarts.ECharts | null = null

// 数据或所选账号变化时重画。用 watch 而不是在 load() 里直接调用：
// 切换账号不重新请求，但图必须跟着换。
watch([current, recentDaily], async () => {
  await nextTick()
  renderGrantChart()
}, { deep: false })

function onResize() { grantChart?.resize() }

onMounted(() => {
  load()
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  grantChart?.dispose()
  grantChart = null
})
</script>

<style scoped>
/* 高度含 X 轴标签带，避免卡片里出现内嵌滚动条 */
.grant-chart {
  height: 240px;
  width: 100%;
}

/* 选中行给左侧色条 + 底色，让「下方明细属于哪一行」一眼可见 */
:deep(.row-selected) > td {
  background: var(--lab-primary-dim) !important;
}
:deep(.row-selected) > td:first-child {
  box-shadow: inset 3px 0 0 var(--lab-primary);
}

/* 切换按钮加大：默认 solid 按钮太小，点完看不出选中态变化 */
:deep(.acct-btn) {
  min-height: 40px;
  line-height: 38px;
  padding: 0 16px;
  font-size: 14px;
}

/* 当前账号大标题：青色信号条 + 极淡渐变，与侧栏选中态同一套语言 */
.acct-banner {
  background: linear-gradient(90deg, var(--lab-primary-dim) 0%, transparent 100%);
  border: 1px solid var(--lab-border-strong);
  border-left: 3px solid var(--lab-primary);
  border-radius: 10px;
  padding: 14px 18px;
}

/* 切换账号时整块淡入：数据换了要有个视觉确认 */
.detail-block {
  animation: fade-in 0.22s ease-out;
}
@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
</style>
