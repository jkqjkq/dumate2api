<template>
  <div class="page">
    <PageHeader title="任务记录" sub="签到、任务、抽奖与自动发放的操作流水">
      <template #actions>
        <a-select
          v-model:value="filterType"
          size="small"
          style="width: 120px"
          :options="typeOptions"
        />
        <a-select
          v-model:value="filterAccount"
          size="small"
          style="width: 150px"
          :options="accountOptions"
        />
        <a-select
          v-model:value="filterDays"
          size="small"
          style="width: 110px"
          :options="dayOptions"
        />
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
    </PageHeader>

    <!-- 签到日历：数据来自上游 sign_in_days，是权威的「哪天签过」 -->
    <a-card title="签到日历" :bordered="false" class="mb-4">
      <a-spin :spinning="calLoading">
        <a-empty v-if="!calendar?.accounts?.length" description="还没有账号" />
        <div v-for="a in calendar?.accounts ?? []" :key="a.account_id" class="mb-4">
          <div class="flex items-center justify-between mb-2">
            <div>
              <span class="font-medium">{{ a.nickname || a.name }}</span>
              <a-tag
                :color="a.has_issued_today ? 'green' : 'orange'"
                class="ml-2"
              >
                {{ a.has_issued_today ? '今日已签' : '今日未签' }}
              </a-tag>
              <span class="text-xs text-slate-500 ml-2">
                累计 {{ a.total_times ?? '—' }} 次 · 本月 {{ a.sign_in_days.length }} 天
              </span>
            </div>
            <a-tag v-if="!a.ok" color="red">{{ a.error }}</a-tag>
          </div>
          <div class="flex flex-wrap gap-1">
            <a-tag
              v-for="d in monthDays(a)"
              :key="d.day"
              :color="d.signed ? 'green' : d.isToday ? 'blue' : 'default'"
              :title="d.day"
            >
              {{ d.label }}
            </a-tag>
          </div>
        </div>
      </a-spin>
    </a-card>

    <!-- 按天聚合：一眼看出哪天做了什么。
         只标类型不显示次数——「哪天做过什么」是这张表要回答的，
         次数在下面的明细里能数，放在这里只会让每行变长。 -->
    <a-card title="活动概览" :bordered="false" class="mb-4">
      <a-empty v-if="!records?.daily?.length" description="还没有操作记录" />
      <a-table
        v-else
        size="small"
        :pagination="false"
        :data-source="records.daily"
        :columns="dailyColumns"
        row-key="account_id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            {{ record.account }}
          </template>
          <template v-else-if="column.key === 'days'">
            <div v-for="(acts, day) in record.days" :key="day" class="text-xs leading-5">
              <span class="text-slate-400">{{ day }}</span>
              <a-tag
                v-for="(_, t) in acts"
                :key="t"
                :color="typeColor(String(t))"
                class="ml-1"
              >
                {{ typeText(String(t)) }}
              </a-tag>
            </div>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- 明细时间轴 -->
    <a-card title="操作明细" :bordered="false">
      <a-table
        size="small"
        :data-source="records?.rows ?? []"
        :columns="detailColumns"
        row-key="rowKey"
        :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <!-- 自动发放显示真实发放时刻（服务端 00:00 发的），
                 不是「我们查到的时刻」——否则会看起来像点签到才发的 -->
            <span class="text-xs">
              {{ new Date(record.type === 'grant' && record.granted_at ? record.granted_at : record.ts).toLocaleString('zh-CN') }}
            </span>
          </template>
          <template v-else-if="column.key === 'type'">
            <a-tag :color="typeColor(record.type)">{{ typeText(record.type) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'account'">
            {{ record.account }}
          </template>
          <template v-else-if="column.key === 'detail'">
            <template v-if="record.type === 'checkin'">
              {{ checkinText(record.result) }}
              <a-tag v-if="!record.ok" color="red" class="ml-1">失败</a-tag>
              <span v-if="record.error" class="text-xs text-red-500 ml-1">{{ record.error }}</span>
            </template>
            <template v-else-if="record.type === 'task'">
              {{ record.title }}
              <a-tag v-if="record.already" color="default" class="ml-1">已发放</a-tag>
              <a-tag v-if="!record.ok" color="red" class="ml-1">失败</a-tag>
              <span v-if="record.error" class="text-xs text-red-500 ml-1">{{ record.error }}</span>
            </template>
            <template v-else-if="record.type === 'draw'">
              <template v-if="record.prize">
                抽到 <span class="font-medium">{{ record.prize }}</span>
              </template>
              <template v-else>抽了 {{ record.count || 1 }} 次</template>
            </template>
            <template v-else-if="record.type === 'grant'">
              登录奖励 <span class="font-medium">+{{ record.points_delta }}</span>
              <a-tag color="blue" class="ml-1">自动</a-tag>
              <span class="text-xs text-slate-400 ml-1">{{ record.note }}</span>
            </template>
          </template>
          <template v-else-if="column.key === 'points'">
            <template v-if="record.points_delta !== null && record.points_delta !== undefined">
              <span :class="record.points_delta > 0 ? 'text-green-600' : 'text-slate-400'">
                余额 {{ record.points_delta > 0 ? '+' + record.points_delta : record.points_delta }}
                <span
                  v-if="record.points_before !== null && record.points_after !== null"
                  class="text-xs text-slate-400"
                >
                  ({{ fmtNum(record.points_before) }} → {{ fmtNum(record.points_after) }})
                </span>
              </span>
              <div class="text-xs text-slate-400">{{ record.account }}</div>
            </template>
            <!-- 没有 delta 与「delta 为 0」是两回事：前者是没打发放接口（今日已签），
                 后者才是真发了但没增加。这里如实显示 —，不折成 0。 -->
            <span v-else class="text-slate-400">
              —
              <span class="text-xs">本次未发放</span>
            </span>
          </template>
        </template>
      </a-table>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import type { RecordsData, CheckinCalendarData } from '@/api/records'

const records = ref<RecordsData | null>(null)
const calendar = ref<CheckinCalendarData | null>(null)
const loading = ref(false)
const calLoading = ref(false)

const filterType = ref('')
const filterAccount = ref<number | null>(null)
const filterDays = ref(30)

const typeOptions = [
  { label: '全部类型', value: '' },
  { label: '签到', value: 'checkin' },
  { label: '任务', value: 'task' },
  { label: '抽奖', value: 'draw' },
  { label: '自动发放', value: 'grant' },
]
const dayOptions = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
]
const accountOptions = ref<Array<{ label: string; value: number | null }>>([
  { label: '全部账号', value: null },
])

const dailyColumns = [
  { title: '账号', key: 'name', width: '20%' },
  { title: '按天', key: 'days' },
]
const detailColumns = [
  { title: '时间', key: 'ts', width: '18%' },
  { title: '类型', key: 'type', width: '10%' },
  { title: '账号', key: 'account', width: '16%' },
  { title: '结果', key: 'detail' },
  { title: '积分', key: 'points', width: '18%' },
]

const typeText = (t: string) => records.value?.types?.[t] || t
const typeColor = (t: string) =>
  t === 'checkin' ? 'green' : t === 'task' ? 'blue' : t === 'draw' ? 'orange'
    : t === 'grant' ? 'cyan' : 'default'

const fmtNum = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })

// 「今日已签」不等于这次发了分：签到是幂等的，已签就不再打发放接口，
// 所以这行没有本次发放金额。当天额度通常已由服务端在 00:00 自动发过，
// 那份属于当天早些时候的发放，不记在这次调用头上。
function checkinText(r?: string) {
  return r === 'claimed' ? '签到成功'
    : r === 'already' ? '今日已签（本次未发放）'
    : r === 'failed' ? '签到失败' : '—'
}

// 本月逐日：已签来自上游 sign_in_days，今天单独标色
function monthDays(a: { sign_in_days: string[] }) {
  const signed = new Set(a.sign_in_days)
  const now = new Date()
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const out = []
  for (let d = 1; d <= now.getDate(); d++) {
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    out.push({ day: key, label: String(d), signed: signed.has(key), isToday: key === todayKey })
  }
  return out
}

async function load() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (filterType.value) params.set('type', filterType.value)
    if (filterAccount.value) params.set('account_id', String(filterAccount.value))
    params.set('days', String(filterDays.value))
    params.set('limit', '500')
    const { data } = await client.get(`/web-accounts/records?${params}`)
    records.value = data
    // 用记录里出现的账号补全筛选选项，避免额外请求
    if (accountOptions.value.length === 1 && data.daily?.length) {
      accountOptions.value = [
        { label: '全部账号', value: null },
        ...data.daily.map((d: any) => ({ label: d.account, value: d.account_id })),
      ]
    }
  } finally {
    loading.value = false
  }
}

async function loadCalendar() {
  calLoading.value = true
  try {
    const { data } = await client.get('/web-accounts/checkin-calendar')
    calendar.value = data
  } finally {
    calLoading.value = false
  }
}

watch([filterType, filterAccount, filterDays], load)

onMounted(async () => {
  await Promise.all([load(), loadCalendar()])
})
</script>
