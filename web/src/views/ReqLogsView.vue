<template>
  <div class="page">
    <PageHeader title="请求日志">
      <template #sub>
        <template v-if="tab === 'gateway'">
          网关每条转发的原始记录，点行看详情
          <template v-if="data"> · 共 {{ data.total }} 条</template>
        </template>
        <template v-else>
          上游计费记录（与网页端「积分消费记录」同源）
          <template v-if="points"> · 共 {{ points.total }} 条 · 合计 {{ fmtNum(points.consumed_points) }}</template>
        </template>
      </template>
      <template #actions>
        <!-- 通道跟随顶栏的全局切换，不另设选择器 -->
        <a-tag :color="isQw ? 'cyan' : 'blue'" class="mr-1">{{ chLabel }}</a-tag>
        <a-select
          v-if="tab === 'gateway'"
          v-model:value="filterStatus"
          size="small"
          style="width: 100px"
          :options="statusOptions"
        />
        <a-select
          v-else
          v-model:value="filterAccount"
          size="small"
          style="width: 130px"
          :options="accountFilterOptions"
        />
        <a-select v-model:value="days" size="small" style="width: 110px" :options="dayOptions" />
        <a-button
          size="small"
          class="ghost-btn"
          :loading="tab === 'gateway' ? loading : pointsLoading"
          @click="load"
        >
          刷新
        </a-button>
      </template>
    </PageHeader>

    <a-tabs v-model:activeKey="tab" @change="onTabChange">
      <a-tab-pane key="gateway" tab="网关请求" />
      <!-- 「积分消费明细」是搭子上游的计费账单，千问没有这份数据 -->
      <a-tab-pane v-if="!isQw" key="points" tab="积分消费明细" />
    </a-tabs>

    <a-card v-if="tab === 'gateway'" :bordered="false" class="mb-4">
      <a-table
        size="small"
        :data-source="data?.rows ?? []"
        :columns="columns"
        row-key="ts"
        :pagination="pagination"
        :loading="loading"
        :custom-row="customRow"
        @change="onTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <span class="text-xs">{{ fmtTime(record.ts) }}</span>
          </template>
          <template v-else-if="column.key === 'path'">
            <span class="font-mono text-xs">{{ record.path }}</span>
            <a-tag v-if="record.stream" color="blue" class="ml-1">流式</a-tag>
          </template>
          <template v-else-if="column.key === 'channel'">
            <!-- 历史记录没有 channel 字段（分通道之前产生的），如实显示「—」
                 而不是默认成搭子——那会让搭子的历史数字凭空变大。
                 服务端过滤时把它们算进搭子，但这里仍标注来源，不伪造字段 -->
            <a-tag v-if="record.channel === 'qwenwork'" color="cyan">千问</a-tag>
            <a-tag v-else-if="record.channel === 'dumate'" color="blue">搭子</a-tag>
            <a-tooltip v-else title="分通道埋点上线前的记录">
              <a-tag color="default">搭子*</a-tag>
            </a-tooltip>
          </template>
          <template v-else-if="column.key === 'model'">
            <div class="text-xs">{{ record.model || '—' }}</div>
            <div v-if="record.mapped_model && record.mapped_model !== record.model" class="text-xs text-slate-400">
              → {{ record.mapped_model }}
            </div>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="statusColor(record.status)">{{ record.status || '中断' }}</a-tag>
          </template>
          <template v-else-if="column.key === 'ms'">
            <span class="text-xs">{{ fmtMs(record.ms) }}</span>
            <div v-if="record.first_token_ms" class="text-xs text-slate-400">首字 {{ fmtMs(record.first_token_ms) }}</div>
          </template>
          <template v-else-if="column.key === 'tokens'">
            <span class="text-xs">{{ compact(record.total_tokens) }}</span>
            <div class="text-xs text-slate-400">{{ compact(record.input_tokens) }} / {{ compact(record.output_tokens) }}</div>
          </template>
          <template v-else-if="column.key === 'client'">
            <span class="text-xs">{{ record.key || (record.key_id ? `key-${record.key_id}` : '未用密钥') }}</span>
            <div class="text-xs text-slate-400">{{ uaShort(record.ua) }}</div>
          </template>
          <template v-else-if="column.key === 'points'">
            <!-- 千问通道：扣的是千问自己的积分池，与搭子的余额游标是两套账。
                 按 req_id 精确配对，归因要等结算，刚发出的请求可能还没值 -->
            <template v-if="record.channel === 'qwenwork'">
              <span v-if="record.qw_total !== undefined" class="text-xs">
                <span :class="record.qw_pool === 'daily' ? 'text-cyan-500' : 'text-blue-500'">
                  {{ fmtQw(record.qw_total) }}
                </span>
                <div class="text-xs text-slate-400">
                  {{ poolLabel(record.qw_pool) }}
                  <a-tooltip v-if="record.qw_concurrent" title="与相邻请求并发，差值可能含其它请求的消耗">
                    <span class="text-orange-500">· 并发</span>
                  </a-tooltip>
                </div>
              </span>
              <span v-else class="text-xs text-slate-400">—</span>
            </template>
            <!-- 搭子通道：余额游标差 -->
            <span v-else-if="record.points_delta !== undefined" class="text-xs" :class="record.points_delta > 0 ? 'text-green-600' : 'text-slate-600'">
              {{ record.points_delta > 0 ? '+' : '' }}{{ record.points_delta }}
            </span>
            <span v-else class="text-xs text-slate-400">—</span>
          </template>
          <template v-else-if="column.key === 'ip'">
            <span class="text-xs">{{ record.ip || '—' }}</span>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- 上游积分消费明细：网页端同一份数据，一次转发可能拆成多笔扣费 -->
    <a-card v-if="tab === 'points'" :bordered="false" class="mb-4">
      <a-alert
        type="info"
        show-icon
        class="mb-3"
        message="这是上游的计费记录，不是网关的转发记录"
        :description="points?.note || '两者不是一一对应：一次转发可能拆成多笔扣费。'"
      />
      <div v-if="points?.accounts?.length" class="mb-3 flex flex-wrap gap-2">
        <a-tag v-for="a in points.accounts" :key="a.id" :color="a.ok ? 'blue' : 'red'">
          {{ a.nickname || a.name }}
          <template v-if="a.ok">：{{ fmtNum(a.consumed_points ?? 0) }} 积分 / {{ a.total_count ?? 0 }} 笔</template>
          <template v-else>：{{ a.error }}</template>
        </a-tag>
      </div>
      <div v-if="filterAccount === null" class="text-xs text-slate-500 mb-3">
        全部账号时每个账号各显示最新 {{ pointsPageSize }} 条（合计 {{ points?.total ?? 0 }} 笔）；
        要看更早的记录请选定某个账号再翻页。
      </div>
      <a-table
        size="small"
        :data-source="points?.rows ?? []"
        :columns="pointsColumns"
        row-key="rowKey"
        :pagination="pointsPagination"
        :loading="pointsLoading"
        @change="onPointsTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <span class="text-xs">{{ fmtTime(record.ts) }}</span>
          </template>
          <template v-else-if="column.key === 'account'">
            <span class="text-xs">{{ record.account }}</span>
          </template>
          <template v-else-if="column.key === 'points'">
            <span class="text-xs text-red-500">{{ record.points }}</span>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- 请求详情：抽屉。字段对齐桌面客户端的「请求详情」面板 -->
    <a-drawer v-model:open="detailOpen" title="请求详情" :width="480" placement="right">
      <template v-if="detail">
        <div class="mb-4">
          <div class="text-base font-medium">请求详情 #{{ detail.ts }}</div>
          <div class="text-xs text-slate-500 mt-1">{{ fmtTime(detail.ts) }}</div>
        </div>

        <div class="detail-grid">
          <div class="detail-label">来源 IP</div>
          <div class="detail-value">{{ detail.ip || '—' }}</div>

          <div class="detail-label">密钥</div>
          <div class="detail-value">{{ detail.key || (detail.key_id ? `key-${detail.key_id}` : '未使用') }}</div>

          <div class="detail-label">模型</div>
          <div class="detail-value font-mono text-xs">{{ detail.model || '—' }}</div>

          <div class="detail-label">映射模型</div>
          <div class="detail-value font-mono text-xs">{{ detail.mapped_model || '—' }}</div>

          <div class="detail-label">通道</div>
          <div class="detail-value">
            <a-tag v-if="detail.channel === 'qwenwork'" color="cyan">千问办公</a-tag>
            <a-tag v-else-if="detail.channel === 'dumate'" color="blue">百度搭子</a-tag>
            <span v-else class="text-slate-400">百度搭子（分通道前的记录）</span>
          </div>

          <div class="detail-label">状态码</div>
          <div class="detail-value">
            <a-tag :color="statusColor(detail.status)">{{ detail.status || '中断' }}</a-tag>
          </div>

          <div class="detail-label">首字延迟</div>
          <div class="detail-value">{{ fmtMs(detail.first_token_ms) }}</div>

          <div class="detail-label">总耗时</div>
          <div class="detail-value">{{ fmtMs(detail.ms) }}</div>

          <div class="detail-label">Prompt Token</div>
          <div class="detail-value">{{ fmtNum(detail.input_tokens) }}</div>

          <div class="detail-label">Completion Token</div>
          <div class="detail-value">{{ fmtNum(detail.output_tokens) }}</div>

          <div class="detail-label">实际扣费</div>
          <div class="detail-value">
            <!-- 千问：扣的是千问自己的池子（免费每日额度 / 付费月度长期），
                 与搭子的余额游标是两套账，必须分开显示 -->
            <template v-if="detail.channel === 'qwenwork'">
              <template v-if="detail.qw_total !== undefined">
                {{ fmtQw(detail.qw_total) }} 积分
                <a-tag :color="detail.qw_pool === 'daily' ? 'cyan' : 'blue'" class="ml-1">
                  {{ detail.qw_pool === 'daily' ? '每日免费额度' : (detail.qw_pool === 'paid' ? '付费积分' : '未扣费') }}
                </a-tag>
                <!-- 「每日免费额度」vs「付费积分」是用户明确要看的区分 -->
                <div class="text-xs mt-1">
                  <span class="text-cyan-500">免费 {{ fmtQw(detail.qw_free) }}</span>
                  <span class="mx-1 text-slate-400">·</span>
                  <span class="text-blue-500">付费 {{ fmtQw(detail.qw_paid) }}</span>
                </div>
                <!-- 千问是单账号直连，但显示出来便于核对「这条是不是我的号」 -->
                <div v-if="detail.qw_account" class="text-xs text-slate-400 mt-1">
                  账号：{{ detail.qw_account.name || '—' }}
                  <span v-if="detail.qw_account.tier">（{{ detail.qw_account.tier }}）</span>
                </div>
                <div v-if="detail.qw_balance" class="text-xs text-slate-400">
                  请求后余额：每日 {{ fmtQw(detail.qw_balance.daily) }} ·
                  月度 {{ fmtQw(detail.qw_balance.monthly) }} ·
                  长期 {{ fmtQw(detail.qw_balance.longterm) }}
                </div>
                <div v-if="detail.qw_concurrent" class="text-xs text-orange-500">
                  与相邻请求并发，差值可能含其它请求的消耗
                </div>
              </template>
              <template v-else>
                —
                <span class="text-xs text-slate-400">
                  （归因要等结算，稍后刷新；或该请求未产生扣费）
                </span>
              </template>
            </template>
            <template v-else-if="detail.points_delta !== undefined">
              {{ detail.points_delta > 0 ? '+' : '' }}{{ detail.points_delta }}
              <span v-if="detail.points_exact === false" class="text-xs text-orange-500">
                （与相邻请求并发，差值可能含其它请求的消耗）
              </span>
            </template>
            <template v-else>
              —
              <span class="text-xs text-slate-400">（无余额参照点，实测不到）</span>
            </template>
          </div>

          <div class="detail-label">流式</div>
          <div class="detail-value">{{ detail.stream ? '是' : '否' }}</div>

          <div class="detail-label">User-Agent</div>
          <div class="detail-value break-all text-xs">{{ detail.ua || '—' }}</div>

          <div class="detail-label">错误</div>
          <div class="detail-value">{{ detail.error || '—' }}</div>
        </div>
      </template>
    </a-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import { channelStore, CHANNELS, isDirectChannel } from '@/stores/channel'
import type { ReqLogRow, ReqLogsData, PointsRecord, PointsRecordsData } from '@/api/reqlogs'

const data = ref<ReqLogsData | null>(null)
const loading = ref(false)
const days = ref(7)
const filterStatus = ref('all')
const page = ref(1)
const pageSize = 50

const tab = ref<'gateway' | 'points'>('gateway')
const points = ref<PointsRecordsData | null>(null)
const pointsLoading = ref(false)
const pointsPage = ref(1)
const pointsPageSize = 50
const filterAccount = ref<number | null>(null)

const detail = ref<ReqLogRow | null>(null)
const detailOpen = ref(false)

// 当前通道。网关请求按通道在服务端过滤；「积分消费明细」是搭子上游的账单，
// 千问没有这份数据，所以整页签在千问下隐藏。
// 直连通道（千问办公 / TRAE Work）：账单模型与搭子不同，用统一判定
const isQw = computed(() => isDirectChannel())
const chLabel = computed(() => CHANNELS.find((c) => c.id === channelStore.current)?.label || channelStore.current)

const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '仅成功', value: 'ok' },
  { label: '仅失败', value: 'err' },
]
const dayOptions = [
  { label: '近 24 小时', value: 1 },
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
]

const columns = [
  { title: '时间', key: 'ts', width: '15%' },
  { title: '路径', key: 'path', width: '17%' },
  { title: '通道', key: 'channel', width: '9%' },
  { title: '模型', key: 'model', width: '13%' },
  { title: '状态', key: 'status', width: '8%' },
  { title: '耗时', key: 'ms', width: '11%' },
  { title: 'Token（总/入/出）', key: 'tokens', width: '12%' },
  { title: '扣费', key: 'points', width: '8%' },
  { title: '调用方', key: 'client', width: '11%' },
  { title: 'IP', key: 'ip', width: '9%' },
]

// 上游消费明细的列。上游只给「时间 + 金额 + 包 ID」，
// 没有模型/token，所以列就这几项，不凭空补字段
const pointsColumns = [
  { title: '消费时间', key: 'ts', width: '30%' },
  { title: '账号', key: 'account', width: '25%' },
  { title: '消耗积分', key: 'points', width: '20%' },
  { title: '额度包', key: 'package_id', width: '25%' },
]

const accountFilterOptions = computed(() => {
  const opts = [{ label: '全部账号', value: null as number | null }]
  for (const a of points.value?.accounts ?? []) {
    opts.push({ label: a.nickname || a.name, value: a.id })
  }
  return opts
})

const pointsPagination = computed(() => {
  // 上游按账号分页。合并视图下「每账号各取 N 条」的行数是 N×账号数，
  // 与按 pageSize 算出的页码对不上，翻页会错位。所以全部账号时不分页，
  // 只给每个账号的最新一批；选具体账号后才是真正按上游页码翻页。
  if (filterAccount.value === null) return false as const
  return {
    current: pointsPage.value,
    pageSize: pointsPageSize,
    total: points.value?.total ?? 0,
    size: 'small',
    showSizeChanger: false,
    showTotal: (t: number) => `共 ${t} 条`,
  }
})

const pagination = computed(() => ({
  current: page.value,
  pageSize,
  total: data.value?.total ?? 0,
  size: 'small',
  showSizeChanger: false,
  showTotal: (t: number) => `共 ${t} 条`,
}))

const fmtTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })
const fmtNum = (n: number) => (n || 0).toLocaleString('zh-CN')
// 千问积分保留 4 位：实测单次消耗 0.0025，按 2 位显示会变成 0
const fmtQw = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
// 扣费池的中文名：区分「每日免费额度」与「付费积分」是用户明确要看的
const poolLabel = (p?: string) =>
  p === 'daily' ? '每日免费' : p === 'paid' ? '付费积分' : p === 'none' ? '未扣费' : '—'
const fmtMs = (ms: number | null | undefined) =>
  typeof ms !== 'number' ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
const compact = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0))

function uaShort(ua?: string) {
  if (!ua) return ''
  // 取最有辨识度的一段：claude-cli/2.1.270 (external, cli) → claude-cli/2.1.270
  const m = ua.match(/([\w.-]+\/[\d.]+)/)
  return m ? m[1] : ua.slice(0, 40)
}

function statusColor(s: number) {
  if (s >= 200 && s < 400) return 'green'
  if (s >= 400 && s < 500) return 'orange'
  if (s >= 500) return 'red'
  return 'default'
}

function customRow(record: ReqLogRow) {
  return { onClick: () => openDetail(record) }
}

function openDetail(record: ReqLogRow) {
  detail.value = record
  detailOpen.value = true
}

function onTableChange(p: { current: number }) {
  page.value = p.current
  load()
}

async function load() {
  if (tab.value === 'points') return loadPoints()
  loading.value = true
  try {
    const params = new URLSearchParams({
      days: String(days.value),
      status: filterStatus.value,
      // 通道在服务端过滤：日志是滚动的，前端筛只能筛掉当前页的行，
      // 分页总数仍是全通道的，两者会对不上
      channel: isQw.value ? 'qwenwork' : 'dumate',
      limit: String(pageSize),
      offset: String((page.value - 1) * pageSize),
    })
    const { data: d } = await client.get('/reqlogs?' + params.toString())
    data.value = d
  } finally {
    loading.value = false
  }
}

async function loadPoints() {
  pointsLoading.value = true
  try {
    const params = new URLSearchParams({
      days: String(days.value),
      page: String(pointsPage.value),
      limit: String(pointsPageSize),
    })
    if (filterAccount.value) params.set('account_id', String(filterAccount.value))
    const { data: d } = await client.get('/reqlogs/points-records?' + params.toString())
    // 上游不返回唯一 id，用「账号+时间+金额+序号」拼一个稳定 key：
    // 同一秒可能有多笔同额扣费，只靠时间会撞 key 导致表格渲染错乱
    const rows: PointsRecord[] = (d.rows ?? []).map((r: PointsRecord, i: number) => ({
      ...r,
      rowKey: `${r.account_id}-${r.ts}-${r.points}-${i}`,
    }))
    points.value = { ...d, rows }
  } finally {
    pointsLoading.value = false
  }
}

function onTabChange(key: string | number) {
  // 切到消费明细时才请求：两个接口打的是不同上游，没必要一起加载
  if (key === 'points' && !points.value) loadPoints()
}

function onPointsTableChange(p: { current: number }) {
  pointsPage.value = p.current
  loadPoints()
}

// 天数或账号筛选变了要重新拉；页码回到第一页，否则会停在越界的空页上
watch([days, filterAccount], () => {
  if (tab.value !== 'points') return
  pointsPage.value = 1
  loadPoints()
})

// 切通道：日志要按新通道重拉，并回到第一页——新通道的总条数不同，
// 停在原来的页码会看到空白页
watch(() => channelStore.current, () => {
  page.value = 1
  // 千问下没有「积分消费明细」页签，若正停在那页则切回网关请求
  if (isQw.value && tab.value === 'points') {
    tab.value = 'gateway'
    load()
    return
  }
  load()
})

onMounted(() => load())
</script>

<style scoped>
.detail-grid {
  display: grid;
  grid-template-columns: 130px 1fr;
  row-gap: 14px;
  column-gap: 16px;
  font-size: 13px;
}
.detail-label {
  color: var(--lab-text-mute);
}
.detail-value {
  color: var(--lab-text);
  font-family: var(--lab-mono);
  font-variant-numeric: tabular-nums;
}
</style>
