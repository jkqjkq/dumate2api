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
              <template v-else-if="column.key === 'last'">
                {{ record.last_login ? dateText(record.last_login) : '—' }}
                <span v-if="record.age_days !== null" class="text-slate-400 text-xs ml-1">
                  ({{ record.age_days }} 天前)
                </span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            上游不提供登录态过期时间，此处按凭证存在性与最后登录时间推断
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

const status = ref<SystemStatus | null>(null)
const points = ref<PointsData | null>(null)
const accounts = ref<AccountsData | null>(null)
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

const expiringColumns = [
  { title: '类型', key: 'type', dataIndex: 'package_type' },
  { title: '剩余', key: 'left' },
  { title: '到期', key: 'expire' },
]
const accountColumns = [
  { title: '账号', key: 'name', dataIndex: 'name' },
  { title: '状态', key: 'state' },
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
    const [s, p, a] = await Promise.all([
      client.get('/system/status'),
      client.get('/points/points' + (force ? '?refresh=1' : '')),
      client.get('/points/accounts'),
    ])
    status.value = s.data
    points.value = p.data
    accounts.value = a.data
  } catch (e: any) {
    // 积分依赖上游，上游没起来时其余卡片仍应显示，所以只提示不中断
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

onMounted(() => refresh())
</script>
