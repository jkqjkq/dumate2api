<template>
  <div class="page">
    <PageHeader title="用量统计">
      <template #sub>
        按时间、模型与密钥维度统计 Token 消耗与请求量
        <template v-if="lastRefresh"> · 更新于 {{ lastRefresh }}</template>
      </template>
      <template #actions>
        <!-- 通道跟随顶栏的全局切换，不在这里另设选择器——两处各有一个
             开关必然出现互相矛盾的状态。这里只显示当前在看哪条通道 -->
        <a-tag :color="isQw ? 'cyan' : 'blue'" class="mr-1">{{ chLabel }}</a-tag>
        <a-select v-model:value="days" size="small" style="width: 110px" :options="dayOptions" />
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
    </PageHeader>

    <!-- 顶部卡片 -->
    <a-row :gutter="[16, 16]">
      <a-col :span="6">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="今日请求" :value="data?.cards.today.requests ?? '—'" value-style="color:#22d3ee" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data">{{ compact(data.cards.today.tokens) }} Token</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="本周请求" :value="data?.cards.week.requests ?? '—'" value-style="color:#fbbf24" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data">{{ compact(data.cards.week.tokens) }} Token</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false" class="h-full">
          <!-- 三条通道三种账：搭子是上游账单（今日实付）、千问是免费额度余额、
               TRAE 是按账号独立的剩余额度。同一张卡按通道换语义，
               但都要标出数字来源，否则额度政策一变没人知道数字错在哪 -->
          <a-statistic
            :title="isTw ? '剩余额度' : isQw ? '免费额度余额' : '今日实付'"
            :value="isTw
              ? (twTotals.remain ?? '—')
              : isQw
                ? (qw?.ok ? fmtQw(qw.free) : '—')
                : (data?.cards.today.consumed_points ?? '—')"
            :precision="isQw || isTw || data?.cards.today.consumed_points == null ? undefined : 2"
            :suffix="isQw && qw?.ok ? `/ ${qw.dailyCap}` : ''"
            :value-style="isQw || isTw ? 'color:#22d3ee' : undefined"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="isTw">
              <template v-if="twTotals.remain != null">
                按账号独立计算<template v-if="twTotals.limit">
                  · 上限合计 {{ twTotals.limit.toLocaleString('zh-CN') }}
                </template>
              </template>
              <span v-else>取不到 TRAE 额度</span>
            </template>
            <template v-else-if="isQw">
              <template v-if="qw?.ok">
                <a-tag :color="qw.calibrated ? 'cyan' : 'default'" class="qw-mini">
                  {{ qw.calibrated ? '实测' : '配置兜底' }}
                </a-tag>
                每日 00:00 重置 · 上限 {{ qw.limitSource === 'observed' ? '按观测峰值' : '取自配置' }}
              </template>
              <span v-else>{{ qw?.error || '取不到千问积分' }}</span>
            </template>
            <template v-else-if="data">{{ data.cards.today.point_records }} 条计费记录</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="活跃密钥" :value="data?.cards.active_keys ?? '—'" value-style="color:#34d399" />
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
            <template v-if="data.cards.today.consumed_points !== null">
              {{ fmt(data.cards.today.consumed_points) }}
              <span class="text-xs text-slate-400 ml-1">
                （{{ data.cards.today.point_records }} 条）
              </span>
            </template>
            <!-- 千问的积分不进搭子上游账单：如实显示 —，不补 0
                 （会被读成「今天没花钱」），具体数字在下方「千问办公积分」卡 -->
            <span v-else class="text-slate-400">—</span>
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

        <!-- 按通道：千问首帧实测 6.7s，与搭子混在同一均值里会让
             「平均首字延迟」既偏高又无法归因，所以分开列 -->
        <div v-if="data.by_channel?.length" class="mt-3">
          <div class="text-xs text-slate-500 mb-1">按通道</div>
          <div class="flex flex-wrap gap-2">
            <a-tag
              v-for="c in data.by_channel"
              :key="c.id"
              :color="c.id === 'qwenwork' ? 'cyan' : (c.id === 'dumate' ? 'blue' : 'default')"
            >
              {{ c.label }} · {{ compact(c.total_tokens) }} · {{ c.requests }} 次
              <span v-if="c.avg_first_token_ms != null" class="opacity-70">
                · 首字 {{ fmtMs(c.avg_first_token_ms) }}
              </span>
              <span v-if="c.failed" class="text-red-500 ml-1">失败 {{ c.failed }}</span>
            </a-tag>
          </div>
          <div v-if="hasUntagged" class="text-xs text-slate-400 mt-1">
            「未标注」是分通道埋点上线前的历史记录，不并入任一通道。
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

    <!-- 千问办公的积分池。与搭子的「按账号积分消耗」是两套账：
         千问是单账号直连，积分在 qwenwork.cn 的三个池子里 -->
    <a-card v-if="isQw" title="千问办公积分" :bordered="false" class="mt-4">
      <a-empty v-if="!qw?.ok" :description="qw?.error || '取不到千问积分'" />
      <template v-else>
        <a-row :gutter="[16, 16]">
          <a-col v-for="w in qw.wallets" :key="w.id" :span="6">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">{{ w.label }}</span>
                <a-tag :color="w.kind === 'free' ? 'cyan' : 'blue'" class="qw-mini">
                  {{ w.kind === 'free' ? '免费' : '付费' }}
                </a-tag>
              </div>
              <div class="qw-pool-value num">
                {{ fmtQw(w.balance) }}
                <span v-if="w.id === 'daily'" class="qw-pool-cap">/ {{ qw.dailyCap }}</span>
              </div>
              <div class="qw-pool-sub">
                <template v-if="w.id === 'daily'">
                  每日 00:00 重置<template v-if="w.resetAt"> · {{ fmtReset(w.resetAt) }}</template>
                </template>
                <template v-else-if="w.id === 'monthly'">订阅套餐内</template>
                <template v-else>充值 / 赠送</template>
              </div>
            </div>
          </a-col>
          <a-col :span="6">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">今日消耗</span>
                <a-tag class="qw-mini">经本网关</a-tag>
              </div>
              <div class="qw-pool-value num">{{ fmtQw(qw.today.total) }}</div>
              <div class="qw-pool-sub">
                免费 {{ fmtQw(qw.today.free) }} · 付费 {{ fmtQw(qw.today.paid) }} ·
                {{ qw.today.requests }} 次
              </div>
            </div>
          </a-col>
        </a-row>

        <!-- 两套口径必须分开写清楚，否则用户会把它们相加 -->
        <a-alert type="info" show-icon class="mt-3">
          <template #message>
            两套口径，<b>不要相加</b>
          </template>
          <template #description>
            <div>
              「今日消耗（经本网关）」= {{ fmtQw(qw.today.total) }} —— 只统计经过本网关转发的请求。
            </div>
            <div>
              「今日全部消耗」= {{ fmtQw(qw.freeUsed) }} —— 上限减余额得出，
              含在客户端 / 网页里直接对话的部分。
              <span class="text-slate-400">
                （上限 {{ fmtQw(qw.limit) }}，来源：
                {{ qw.limitSource === 'observed' ? '观测峰值' : '配置兜底' }}）
              </span>
            </div>
          </template>
        </a-alert>
      </template>
    </a-card>

    <!-- TRAE Work 的额度。与千问的三个池子、搭子的上游账单是三套账，
         不合并成一个「积分」区块——合并出来的数字没有任何一处对得上 -->
    <a-card v-if="isTw" title="TRAE Work 额度" :bordered="false" class="mt-4">
      <a-empty v-if="!twRows.length" description="还没有 TRAE Work 账号" />
      <template v-else>
        <a-table
          size="small"
          :pagination="false"
          :data-source="twRows"
          :columns="twColumns"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              {{ record.nickname || record.uid || '未命名' }}
              <div v-if="record.error" class="text-xs text-red-500">{{ record.error }}</div>
            </template>
            <template v-else-if="column.key === 'remain'">
              <span v-if="record.remain != null" class="font-medium num">
                {{ record.remain.toLocaleString('zh-CN') }}
              </span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'limit'">
              <span v-if="record.limit" class="num">{{ record.limit.toLocaleString('zh-CN') }}</span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'checkin'">
              <a-tag v-if="record.checkedIn == null" color="default">—</a-tag>
              <a-tag v-else :color="record.checkedIn ? 'green' : 'orange'">
                {{ record.checkedIn ? '已签到' : '未签到' }}
              </a-tag>
            </template>
          </template>
        </a-table>
        <div class="text-xs text-slate-400 mt-2">
          额度按账号独立，不共享；取不到时显示 —，不补 0。
          签到每日一次且幂等，重复执行不会多领。
        </div>
      </template>
    </a-card>

    <!-- 按账号积分消耗：只有搭子有上游计费账单。直连通道的账在各自的
         池子里，挂一张空表出来只会让人以为「这条通道没消耗」 -->
    <a-card v-if="!isQw && !isTw" title="按账号积分消耗" :bordered="false" class="mt-4">
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
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import { channelStore, CHANNELS, isTraework, isQwenwork, channelParam } from '@/stores/channel'
import { qwenworkApi } from '@/api/qwenwork'
import { traeworkApi } from '@/api/traework'
import type { TraeworkCreditRow } from '@/api/traework'
import type { QwCredits } from '@/api/qwenwork'
import type { UsageOverview } from '@/api/usage'

// ECharts 按需引入：只加载柱状图需要的模块
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { SERIES, INK, TOOLTIP_BASE, axisStyle, compactNum, exactNum, barSeries } from '@/utils/chartTheme'

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

const data = ref<UsageOverview | null>(null)
const loading = ref(false)
const lastRefresh = ref('')
const days = ref(30)

// 当前通道。**服务端按通道过滤**而不是前端筛已聚合的数字——
// 卡片、折线、按模型表都建立在同一批行上，前端筛只能筛掉表里的行，
// 顶部卡片的数字仍是全通道的，两者会对不上。
// 三条通道：搭子的扣费在上游账单里（pointsUsage）；千问的在 qwenwork.cn
// 的三个池子里；TRAE 的是每个账号独立的 credits。三套账互不相干，
// 不能合并显示——合并出来的数字没有任何一处对得上。
const isTw = computed(() => isTraework())
const isQw = computed(() => isQwenwork())
const chLabel = computed(() => CHANNELS.find((c) => c.id === channelStore.current)?.label || channelStore.current)

// 千问积分。它是**另一套账**：搭子的扣费在上游账单里（pointsUsage），
// 千问的在 qwenwork.cn 的三个池子里，两边互不相干，不能合并显示。
// 拉取在 load() 里与用量并行做。
const qw = ref<QwCredits | null>(null)

// TRAE 的额度：按账号独立。与千问的三个池子不同，这里只看「剩余多少」。
const twRows = ref<TraeworkCreditRow[]>([])
const twTotals = computed(() => {
  let remain: number | null = null
  let limit: number | null = null
  for (const r of twRows.value) {
    if (r.remain != null) remain = (remain ?? 0) + r.remain
    if (r.limit != null) limit = (limit ?? 0) + r.limit
  }
  return { remain, limit }
})

// 积分保留 2~4 位：实测单次消耗 0.0025，按 2 位显示会变成 0
const fmtQw = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 })

// 免费额度的重置时刻（接口给的是 wallet 的 valid_to）
const fmtReset = (s: string) => {
  const d = new Date(s)
  return Number.isFinite(d.getTime())
    ? d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : s
}

// 「未标注」= channel 字段上线前的历史记录。不并入任一通道——那会让
// 搭子的历史数字凭空变大，而用户无从察觉。
// 首字延迟的展示格式：与请求日志页保持一致（秒/毫秒自动切换）
function fmtMs(ms?: number | null) {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

// 已按单通道过滤时服务端不返回 by_channel（只会得到一行自己的数据），
// 此时不再显示「按通道」区块
const hasUntagged = computed(() => (data.value?.by_channel || []).some((c) => c.id === 'untagged'))

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
// TRAE 的额度表：剩余 / 上限 / 签到。没有「消耗积分」列——上游不给
// 逐笔账单，只有存量快照
const twColumns = [
  { title: '账号', key: 'name' },
  { title: '剩余额度', key: 'remain', width: '24%' },
  { title: '额度上限', key: 'limit', width: '24%' },
  { title: '今日签到', key: 'checkin', width: '20%' },
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
    grid: { left: 60, right: 16, top: 12, bottom: 26 },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any[]) => {
        const row = rows[params[0].dataIndex]
        // 数值为主、名称次之：读者已经知道看的是哪一天，要的是数字
        return `<div style="color:${INK.muted};font-size:11px">${row.day}</div>`
          + `<div style="margin-top:2px">Token <b>${exactNum(row.total_tokens)}</b></div>`
          + `<div>请求 <b>${exactNum(row.requests)}</b></div>`
          + (row.failed ? `<div style="color:#f87171">失败 <b>${exactNum(row.failed)}</b></div>` : '')
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.day.slice(5)),
      ...axisStyle({ showGrid: false }),
    },
    yAxis: {
      type: 'value',
      ...axisStyle({ formatter: (v: number) => compactNum(v) }),
    },
    // 单序列用槽位 1 一种颜色即可，不做「越大越深」的值映射——
    // 那会把长度已经表达过的信息再用色相编码一遍，白白占掉唯一的颜色通道
    series: [barSeries({ data: rows.map((r) => r.total_tokens), color: SERIES[0] })],
  })
}

async function load() {
  loading.value = true
  try {
    // 服务端按通道过滤。TRAE 走 channelParam() 而不是硬编码——
    // 加第四条通道时不该再来改这里
    const ch = channelParam()
    // 额度与用量并行拉：两者互不依赖，串行只会白等一个来回
    const [usage, credits] = await Promise.all([
      client.get(`/usage/overview?days=${days.value}&channel=${ch}`),
      isTw.value ? traeworkApi.credits().catch(() => ({ data: { count: 0, rows: [] } }))
        : isQw.value ? qwenworkApi.credits() : Promise.resolve(null),
    ])
    data.value = usage.data
    if (isTw.value) twRows.value = (credits as any)?.data?.rows || []
    else if (isQw.value) qw.value = (credits as any).data
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    await nextTick()
    renderChart()
  } finally {
    loading.value = false
  }
}

function onResize() { chartInst?.resize() }

watch(days, load)
// 切通道要重新拉数据（服务端过滤），不能只改前端显示
watch(() => channelStore.current, load)

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

<style scoped>
/* 千问积分池：并列小卡，密度与顶部卡片保持一致 */
.qw-pool {
  padding: 12px 14px;
  border: 1px solid var(--lab-border);
  border-radius: 10px;
  background: var(--lab-surface-2);
  height: 100%;
}
.qw-pool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.qw-pool-label {
  font-size: 12px;
  color: var(--lab-text-sub);
}
.qw-pool-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--lab-text);
  line-height: 1.3;
}
.qw-pool-cap {
  font-size: 12px;
  font-weight: 400;
  color: var(--lab-text-mute);
}
.qw-pool-sub {
  margin-top: 4px;
  font-size: 11px;
  color: var(--lab-text-mute);
  line-height: 1.6;
}
.qw-mini {
  font-size: 10px;
  line-height: 16px;
  padding: 0 6px;
  margin: 0;
}
</style>
