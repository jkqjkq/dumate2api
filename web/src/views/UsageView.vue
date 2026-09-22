<template>
  <div>
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-medium m-0">用量统计</h2>
        <div class="text-xs text-slate-500 mt-1">
          按时间、模型与密钥维度统计 Token 消耗与请求量
          <template v-if="lastRefresh"> · 更新于 {{ lastRefresh }}</template>
        </div>
      </div>
      <a-space>
        <a-select v-model:value="days" size="small" style="width: 110px" :options="dayOptions" />
        <a-button size="small" :loading="loading" @click="load">刷新</a-button>
      </a-space>
    </div>

    <!-- 顶部卡片 -->
    <a-row :gutter="[16, 16]">
      <a-col :span="6">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="今日请求" :value="data?.cards.today.requests ?? '—'" value-style="color:#1677ff" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data">{{ compact(data.cards.today.tokens) }} Token</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="本周请求" :value="data?.cards.week.requests ?? '—'" value-style="color:#722ed1" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data">{{ compact(data.cards.week.tokens) }} Token</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="今日实付" :value="data?.cards.today.consumed_points ?? '—'" :precision="2" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data">
              {{ data.cards.today.point_records }} 条计费记录
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="活跃密钥" :value="data?.cards.active_keys ?? '—'" value-style="color:#52c41a" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data">
              主力模型 {{ data.cards.top_model || '—' }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <!-- 今日概览：只有请求数与 token 说不清「今天跑得怎么样」，
         补上成功率、快慢与今日在用的模型 -->
    <a-card title="今日概览" :bordered="false" class="mt-4">
      <a-empty v-if="!data?.cards.today.requests" description="今天还没有请求" />
      <template v-else>
        <a-descriptions :column="4" size="small" bordered>
          <a-descriptions-item label="请求数">
            {{ fmt(data.cards.today.requests) }}
            <a-tag v-if="data.cards.today.failed" color="red" class="ml-1">
              失败 {{ data.cards.today.failed }}
            </a-tag>
          </a-descriptions-item>
          <a-descriptions-item label="成功率">
            <span :class="successRateColor">{{ successRateText }}</span>
          </a-descriptions-item>
          <a-descriptions-item label="Token">
            {{ compact(data.cards.today.tokens) }}
          </a-descriptions-item>
          <a-descriptions-item label="实付积分">
            {{ fmt(data.cards.today.consumed_points) }}
            <span class="text-xs text-slate-400 ml-1">
              （{{ data.cards.today.point_records }} 条）
            </span>
          </a-descriptions-item>
          <a-descriptions-item label="平均耗时">
            {{ data.cards.today.avg_ms !== null ? fmt(data.cards.today.avg_ms) + ' ms' : '—' }}
          </a-descriptions-item>
          <a-descriptions-item label="平均首字">
            <template v-if="data.cards.today.avg_first_token_ms !== null">
              {{ fmt(data.cards.today.avg_first_token_ms) }} ms
              <span class="text-xs text-slate-400 ml-1">
                （{{ data.cards.today.first_token_samples }} 条样本）
              </span>
            </template>
            <span v-else class="text-slate-400">—</span>
          </a-descriptions-item>
          <a-descriptions-item label="输入 / 输出">
            {{ compact(data.cards.today.input_tokens) }} /
            {{ compact(data.cards.today.output_tokens) }}
          </a-descriptions-item>
          <a-descriptions-item label="流式请求">
            {{ fmt(data.cards.today.stream_count) }}
          </a-descriptions-item>
        </a-descriptions>

        <div v-if="data.cards.today.models.length" class="mt-3">
          <div class="text-xs text-slate-500 mb-1">今日用量按模型</div>
          <div class="flex flex-wrap gap-2">
            <a-tag v-for="m in data.cards.today.models" :key="m.model" color="blue">
              {{ m.model }} · {{ compact(m.tokens) }}
            </a-tag>
          </div>
        </div>
      </template>
    </a-card>

    <a-alert
      v-if="data"
      type="info"
      show-icon
      class="mt-4"
      :message="data.note"
    />

    <!-- Token 消耗趋势 -->
    <a-card title="Token 消耗趋势" :bordered="false" class="mt-4">
      <template #extra><span class="text-xs text-slate-400">按天聚合</span></template>
      <a-empty v-if="!data?.daily.length" description="还没有请求记录" />
      <div v-else ref="chartEl" style="height: 280px"></div>
    </a-card>

    <!-- 按模型 / 按密钥 -->
    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="12">
        <a-card title="按模型" :bordered="false">
          <a-empty v-if="!data?.by_model.length" description="暂无数据" />
          <a-table
            v-else
            size="small"
            :pagination="{ pageSize: 10, size: 'small', showSizeChanger: false }"
            :data-source="data.by_model"
            :columns="modelColumns"
            row-key="model"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <span class="font-mono text-xs">{{ record.model }}</span>
              </template>
              <template v-else-if="column.key === 'tokens'">
                {{ compact(record.total_tokens) }}
              </template>
              <template v-else-if="column.key === 'requests'">
                {{ fmt(record.requests) }}
                <a-tag v-if="record.failed" color="red" class="ml-1">{{ record.failed }}</a-tag>
              </template>
            </template>
          </a-table>
        </a-card>
      </a-col>

      <a-col :span="12">
        <a-card title="按密钥" :bordered="false">
          <a-empty v-if="!data?.by_key.length" description="暂无数据" />
          <a-table
            v-else
            size="small"
            :pagination="false"
            :data-source="data.by_key"
            :columns="keyColumns"
            row-key="name"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                {{ record.name }}
              </template>
              <template v-else-if="column.key === 'tokens'">
                {{ compact(record.total_tokens) }}
              </template>
              <template v-else-if="column.key === 'requests'">
                {{ fmt(record.requests) }}
                <a-tag v-if="record.failed" color="red" class="ml-1">{{ record.failed }}</a-tag>
              </template>
            </template>
          </a-table>
          <div v-if="data && !data.cards.active_keys" class="text-xs text-slate-400 mt-2">
            网关鉴权当前关闭（所有请求都未带密钥），因此没有密钥维度的区分。
          </div>
        </a-card>
      </a-col>
    </a-row>

    <!-- 按账号积分消耗 -->
    <a-card title="按账号积分消耗" :bordered="false" class="mt-4">
      <div class="text-xs text-slate-500 mb-2">
        来自上游计费记录（近 {{ data?.days ?? days }} 天）——本地日志算不出扣费，单价在上游。
      </div>
      <a-table
        size="small"
        :pagination="false"
        :data-source="data?.points_by_account ?? []"
        :columns="accountColumns"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            {{ record.name }}
            <div v-if="!record.ok" class="text-xs text-red-500">{{ record.error }}</div>
          </template>
          <template v-else-if="column.key === 'consumed'">
            <span v-if="record.ok">{{ fmt(record.consumed_points) }}</span>
            <span v-else class="text-slate-400">—</span>
          </template>
          <template v-else-if="column.key === 'count'">
            <span v-if="record.ok">{{ fmt(record.count) }}</span>
            <span v-else class="text-slate-400">—</span>
          </template>
        </template>
      </a-table>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import client from '@/api/client'
import type { UsageOverview } from '@/api/usage'

// ECharts 按需引入：只加载柱状图需要的模块
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

const data = ref<UsageOverview | null>(null)
const loading = ref(false)
const lastRefresh = ref('')
const days = ref(30)

const dayOptions = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
]

const modelColumns = [
  { title: '模型', key: 'name' },
  { title: '请求', key: 'requests', width: '26%' },
  { title: 'Token', key: 'tokens', width: '26%' },
]
const keyColumns = [
  { title: '密钥', key: 'name' },
  { title: '请求', key: 'requests', width: '26%' },
  { title: 'Token', key: 'tokens', width: '26%' },
]
const accountColumns = [
  { title: '账号', key: 'name' },
  { title: '消耗积分', key: 'consumed', width: '24%' },
  { title: '计费记录', key: 'count', width: '20%' },
]

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const compact = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
    : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)

const successRateText = computed(() => {
  const r = data.value?.cards.today.success_rate
  return r === null || r === undefined ? '—' : r + '%'
})
const successRateColor = computed(() => {
  const r = data.value?.cards.today.success_rate ?? 0
  return r >= 99 ? 'text-green-600' : r >= 95 ? 'text-orange-500' : 'text-red-500'
})

const chartEl = ref<HTMLElement | null>(null)
let chartInst: echarts.ECharts | null = null

function renderChart() {
  if (!chartEl.value || !data.value) return
  if (!chartInst) chartInst = echarts.init(chartEl.value)

  const rows = data.value.daily
  chartInst.setOption({
    grid: { left: 64, right: 16, top: 16, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any[]) => {
        const p = params[0]
        const row = rows[p.dataIndex]
        return `${row.day}<br/>Token ${fmt(row.total_tokens)}<br/>请求 ${fmt(row.requests)}`
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.day.slice(5)),
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisLabel: { color: '#94a3b8', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: '#94a3b8', fontSize: 11,
        formatter: (v: number) => compact(v),
      },
      splitLine: { lineStyle: { color: '#f3f4f6' } },
    },
    series: [{
      type: 'bar',
      data: rows.map((r) => r.total_tokens),
      itemStyle: { color: '#fa541c', borderRadius: [2, 2, 0, 0] },
      barMaxWidth: 28,
    }],
  })
}

async function load() {
  loading.value = true
  try {
    const { data: d } = await client.get(`/usage/overview?days=${days.value}`)
    data.value = d
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    await nextTick()
    renderChart()
  } finally {
    loading.value = false
  }
}

function onResize() { chartInst?.resize() }

watch(days, load)

onMounted(() => {
  window.addEventListener('resize', onResize)
  load()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  chartInst?.dispose()
  chartInst = null
})
</script>
