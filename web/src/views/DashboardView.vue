<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <span class="text-slate-500 text-sm">
        上游端口 {{ status?.upstream.port ?? '—' }}
        <template v-if="points"> · 数据 {{ fetchedAtText }}</template>
      </span>
      <a-button size="small" :loading="loading" @click="refresh(true)">刷新</a-button>
    </div>

    <a-row :gutter="[16, 16]">
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="账号总数" :value="accounts?.total ?? '—'">
            <template #suffix>
              <span class="text-sm text-slate-400">个</span>
            </template>
          </a-statistic>
          <div class="text-xs mt-2">
            <template v-if="accounts">
              <a-tag v-if="accounts.active" color="green">有效 {{ accounts.active }}</a-tag>
              <a-tag v-if="accounts.stale" color="orange">失效 {{ accounts.stale }}</a-tag>
              <a-tag v-if="accounts.unknown" color="default">未知 {{ accounts.unknown }}</a-tag>
            </template>
            <span v-else class="text-slate-400">—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic
            title="积分余额"
            :value="points ? points.left : '—'"
            :precision="points ? 2 : 0"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="points">
              共 {{ fmt(points.total) }} · 已用 {{ fmt(points.used) }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="套餐订阅" :value="subscribedText" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="plan">到期 {{ dateText(plan.expire_at) }}</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="模型限流" :value="throttleText" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="points?.throttle_reason">{{ points.throttle_reason }}</template>
            <span v-else>无限制</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="今日 Token" :value="todayTokensText" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="stats">
              输入 {{ fmt(stats.today.input_tokens) }} · 输出 {{ fmt(stats.today.output_tokens) }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="今日请求" :value="stats ? stats.today.requests : '—'">
            <template #suffix>
              <span class="text-sm text-slate-400">次</span>
            </template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="stats">
              <a-tag v-if="stats.today.failed" color="red">失败 {{ stats.today.failed }}</a-tag>
              <span v-else>全部成功</span>
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="平均耗时" :value="stats ? stats.today.avg_ms : '—'">
            <template #suffix>
              <span class="text-sm text-slate-400">ms</span>
            </template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="stats">近 {{ stats.days }} 天共 {{ fmt(stats.total.total_tokens) }} tokens</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="近 14 天请求" :value="stats ? stats.total.requests : '—'">
            <template #suffix>
              <span class="text-sm text-slate-400">次</span>
            </template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">含所有协议路径</div>
        </a-card>
      </a-col>
    </a-row>

    <a-card title="每日用量" :bordered="false" class="mt-4">
      <a-empty v-if="!daily.length" description="还没有请求记录" />
      <div v-else class="flex items-end gap-1 h-32">
        <div
          v-for="d in daily"
          :key="d.day"
          class="flex-1 flex flex-col items-center justify-end h-full group"
          :title="`${d.day}\n请求 ${d.requests} 次\n${fmt(d.total_tokens)} tokens${d.failed ? '\n失败 ' + d.failed : ''}`"
        >
          <div
            class="w-full rounded-t transition-colors"
            :class="d.failed ? 'bg-red-400' : 'bg-blue-500'"
            :style="{ height: barHeight(d.total_tokens) }"
          />
        </div>
      </div>
      <div v-if="daily.length" class="flex justify-between text-xs text-slate-400 mt-2">
        <span>{{ daily[0]?.day }}</span>
        <span>{{ daily[daily.length - 1]?.day }}</span>
      </div>
    </a-card>

    <a-alert
      v-if="error"
      type="warning"
      show-icon
      class="mt-4"
      :message="`积分数据获取失败：${error}`"
    />

    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="12">
        <a-card title="即将到期的额度" :bordered="false">
          <a-empty v-if="!points?.expiring.length" description="没有未用完且临近到期的额度" />
          <a-table
            v-else
            size="small"
            :pagination="false"
            :data-source="points.expiring"
            :columns="expiringColumns"
            row-key="package_type"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'left'">{{ fmt(record.left) }}</template>
              <template v-else-if="column.key === 'expire'">
                {{ dateText(record.expire_at) }}
                <a-tag v-if="daysLeft(record.expire_at) <= 7" color="red" class="ml-1">
                  {{ daysLeft(record.expire_at) }} 天
                </a-tag>
              </template>
              <template v-else-if="column.key === 'type'">
                <a-tag :color="record.kind === 'subscription' ? 'blue' : 'default'">
                  {{ record.package_type || record.kind }}
                </a-tag>
              </template>
            </template>
          </a-table>
        </a-card>
      </a-col>

      <a-col :span="12">
        <a-card title="账号状态" :bordered="false">
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
                <a-tag v-if="record.active" color="blue">当前</a-tag>
              </template>
              <template v-else-if="column.key === 'points'">
                <template v-if="record.points">
                  <span class="font-medium">{{ fmt(record.points.left) }}</span>
                  <span class="text-slate-400 text-xs ml-1">/ {{ fmt(record.points.total) }}</span>
                </template>
                <a-tooltip v-else :title="record.points_note">
                  <span class="text-slate-400 text-xs">{{ record.points_note }}</span>
                </a-tooltip>
              </template>
              <template v-else-if="column.key === 'last'">
                {{ record.last_login ? dateText(record.last_login) : '—' }}
                <span v-if="record.age_days !== null" class="text-slate-400 text-xs ml-1">
                  ({{ record.age_days }} 天前)
                </span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            上游积分接口只按当前登录账号计算，切换账号后需重启后端才能查另一个账号的积分；
            登录态过期时间上游未提供，按凭证存在性与最后登录时间推断
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="12">
        <a-card title="端口发现链路" :bordered="false">
          <a-empty
            v-if="!status?.upstream.discovery.length"
            description="未通过命令行或监听套接字发现，走了已知端口或自建拉起"
          />
          <a-steps
            v-else
            direction="vertical"
            size="small"
            :current="status.upstream.discovery.findIndex((s) => s.hit)"
          >
            <a-step
              v-for="(step, i) in status.upstream.discovery"
              :key="i"
              :title="step.method"
              :description="`端口 ${step.port}`"
              :status="step.hit ? 'finish' : 'wait'"
            />
          </a-steps>
        </a-card>
      </a-col>
      <a-col :span="12">
        <a-card title="安装与运行时" :bordered="false">
          <a-descriptions :column="1" size="small" bordered>
            <a-descriptions-item label="安装目录">
              <span class="break-all">{{ status?.install.dir }}</span>
            </a-descriptions-item>
            <a-descriptions-item label="后端可执行文件">
              <a-tag :color="status?.install.exe_exists ? 'green' : 'red'">
                {{ status?.install.exe_exists ? '存在' : '缺失' }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="网关">
              <a-tag :color="status?.gateway.online ? 'green' : 'red'">
                {{ status?.gateway.online ? '在线' : '离线' }}
              </a-tag>
              端口 {{ status?.gateway.port }}
            </a-descriptions-item>
            <a-descriptions-item label="Node 版本">{{ status?.versions.node }}</a-descriptions-item>
            <a-descriptions-item label="管理进程">
              PID {{ status?.admin.pid }} / 端口 {{ status?.admin.port }}
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>
    </a-row>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import client from '@/api/client'
import type { SystemStatus } from '@/api/system'
import type { PointsData, AccountsData } from '@/api/points'
import type { StatsSummary, DailyRow } from '@/api/stats'

const status = ref<SystemStatus | null>(null)
const points = ref<PointsData | null>(null)
const accounts = ref<AccountsData | null>(null)
const stats = ref<StatsSummary | null>(null)
const daily = ref<DailyRow[]>([])
const loading = ref(false)
const error = ref('')

const plan = computed(() =>
  points.value?.packages.find((p) => p.kind === 'subscription') ?? null,
)
const subscribedText = computed(() => {
  if (!points.value) return '—'
  return points.value.subscribed ? '已订阅' : '未订阅'
})
const throttleText = computed(() => {
  if (!points.value) return '—'
  return points.value.throttled ? '受限' : '正常'
})
const fetchedAtText = computed(() => {
  if (!points.value) return '—'
  return new Date(points.value.fetched_at).toLocaleTimeString('zh-CN')
})
// 大数字用紧凑写法：仪表盘上 28.2M 比 28,200,000 好读
const todayTokensText = computed(() => {
  if (!stats.value) return '—'
  return compact(stats.value.today.total_tokens)
})

function compact(n: number) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

// 柱高按窗口内最大值归一，最小留 2% 让零值那天也有一条可见的底
function barHeight(v: number) {
  const max = Math.max(...daily.value.map((d) => d.total_tokens), 1)
  return `${Math.max(2, (v / max) * 100)}%`
}

const expiringColumns = [
  { title: '类型', key: 'type', dataIndex: 'package_type' },
  { title: '剩余', key: 'left' },
  { title: '到期', key: 'expire' },
]
const accountColumns = [
  { title: '账号', key: 'name', dataIndex: 'name' },
  { title: '状态', key: 'state' },
  { title: '积分', key: 'points' },
  { title: '最后登录', key: 'last' },
]

const fmt = (n: number) =>
  n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const dateText = (ts: number | null) =>
  ts ? new Date(ts).toLocaleDateString('zh-CN') : '—'
const daysLeft = (ts: number | null) =>
  ts ? Math.ceil((ts - Date.now()) / 86400000) : 0
const stateColor = (s: string) =>
  s === 'active' ? 'green' : s === 'stale' ? 'orange' : 'default'
const stateText = (s: string) =>
  s === 'active' ? '有效' : s === 'stale' ? '失效' : '未知'

async function refresh(force = false) {
  loading.value = true
  error.value = ''
  try {
    const [s, p, a, st, dy] = await Promise.all([
      client.get('/system/status'),
      client.get('/points/points' + (force ? '?refresh=1' : '')),
      client.get('/points/accounts'),
      client.get('/stats/summary'),
      client.get('/stats/daily?days=14'),
    ])
    status.value = s.data
    points.value = p.data
    accounts.value = a.data
    stats.value = st.data
    daily.value = dy.data.rows
  } catch (e: any) {
    // 积分依赖上游，上游没起来时其余卡片仍应显示，所以只提示不中断
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

onMounted(() => refresh())
</script>
