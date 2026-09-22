<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <span class="text-slate-500 text-sm">
        <template v-if="data">上游端口 {{ data.upstream_port }} · 数据 {{ fetchedAt }}</template>
        <template v-else>加载中…</template>
      </span>
      <a-button size="small" :loading="loading" @click="load(true)">刷新</a-button>
    </div>

    <a-alert v-if="error" type="warning" show-icon class="mb-4" :message="`积分获取失败：${error}`" />

    <a-row :gutter="[16, 16]">
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="可用余额" :value="data?.left ?? '—'" :precision="2" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data">共 {{ fmt(data.total) }} · 已用 {{ fmt(data.used) }}</template>
          </div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="额度包数量" :value="data?.packages.length ?? '—'" />
          <div class="text-xs text-slate-500 mt-2">订阅 + 增量包</div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic
            title="即将过期"
            :value="data ? data.expiring.length : '—'"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data?.expiring.length">
              最近 {{ dateText(data.expiring[0].expire_at) }}
            </template>
            <span v-else>没有未用完且临期的额度</span>
          </div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic
            title="已过期未用完"
            :value="data ? data.expired_unused.length : '—'"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data?.expired_unused.length">
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
        :data-source="data?.sources ?? []"
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
      <a-empty v-if="!data?.daily_grant.length" description="没有发放记录" />
      <template v-else>
        <div class="flex items-end gap-1 h-32">
          <div
            v-for="d in recentDaily"
            :key="d.day"
            class="flex-1 flex flex-col items-center justify-end h-full"
            :title="`${d.day}\n发放 ${fmt(d.granted)}\n消耗 ${fmt(d.used)}\n${d.count} 笔`"
          >
            <div class="w-full flex flex-col justify-end h-full">
              <div class="w-full bg-blue-500 rounded-t" :style="{ height: barPct(d.granted) }" />
            </div>
          </div>
        </div>
        <div class="flex justify-between text-xs text-slate-400 mt-2">
          <span>{{ recentDaily[0]?.day }}</span>
          <span>{{ recentDaily[recentDaily.length - 1]?.day }}</span>
        </div>
        <div class="text-xs text-slate-400 mt-1">柱高 = 当日发放额度；悬停查看当日消耗</div>
      </template>
    </a-card>

    <a-card title="逐笔发放记录" :bordered="false" class="mt-4">
      <a-table
        size="small"
        :data-source="data?.packages ?? []"
        :columns="pkgColumns"
        row-key="rowKey"
        :pagination="{ pageSize: 15, size: 'small', showSizeChanger: false }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'">
            <span class="font-mono text-xs">{{ record.source || record.package_type || '—' }}</span>
          </template>
          <template v-else-if="column.key === 'granted'">
            {{ dateText(record.granted_at) }}
          </template>
          <template v-else-if="column.key === 'expire'">
            {{ dateText(record.expire_at) }}
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
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import client from '@/api/client'
import type { PointsData, PointsPackage } from '@/api/points'

const data = ref<PointsData | null>(null)
const loading = ref(false)
const error = ref('')

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
const recentDaily = computed(() => (data.value?.daily_grant ?? []).slice(-14))

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const dateText = (ts: number | null) =>
  ts ? new Date(ts).toLocaleDateString('zh-CN') : '—'
const fetchedAt = computed(() =>
  data.value ? new Date(data.value.fetched_at).toLocaleTimeString('zh-CN') : '—')

// 柱高按窗口内最大发放额归一，最小留 3% 让零值那天也有可见基线
function barPct(v: number) {
  const max = Math.max(...recentDaily.value.map((d) => d.granted), 1)
  return `${Math.max(3, (v / max) * 100)}%`
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
    const { data: d } = await client.get('/points/points' + (force ? '?refresh=1' : ''))
    // 逐笔列表按发放时间倒序；补 rowKey 供表格使用
    const pkgs = (d.packages as PointsPackage[])
      .slice()
      .sort((a, b) => (b.granted_at || 0) - (a.granted_at || 0))
      .map((p, i) => ({ ...p, rowKey: `${p.source}-${p.granted_at}-${i}` }))
    data.value = { ...d, packages: pkgs }
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

onMounted(() => load())
</script>
