<template>
  <div>
    <a-alert type="info" show-icon class="mb-4">
      <template #message>百度搭子账号管理</template>
      <template #description>
        <div>签到、抽奖、积分都属于网页端（dumate.baidu.com），与本地代理网关是两套东西。</div>
        <div class="mt-1">
          登录态位于百度域（<code>baidu.com</code>），网页无法直接读取浏览器 cookie，
          所以添加账号时需要你手动复制一次。
        </div>
      </template>
    </a-alert>

    <a-card :bordered="false">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="font-medium">账号列表</span>
          <span class="text-slate-500 text-sm ml-2">
            共 {{ accounts.length }} 个 · 启用 {{ enabledCount }} 个
          </span>
        </div>
        <a-space>
          <a-button
            :loading="checkingAll"
            :disabled="!enabledCount"
            @click="checkinAll"
          >
            一键签到
          </a-button>
          <a-button type="primary" size="small" @click="openAdd">添加账号</a-button>
        </a-space>
      </div>

      <a-empty v-if="!accounts.length" description="还没有添加账号">
        <a-button type="primary" @click="openAdd">添加第一个账号</a-button>
      </a-empty>

      <a-row v-else :gutter="[16, 16]">
        <a-col v-for="a in accounts" :key="a.id" :span="8">
          <a-card size="small" :bordered="true" class="h-full">
            <div class="flex items-start justify-between">
              <div>
                <div class="font-medium">
                  {{ a.nickname || a.name }}
                  <a-tag v-if="!a.enabled" color="default" class="ml-1">已停用</a-tag>
                </div>
                <div class="text-xs text-slate-400 font-mono mt-1">
                  BDUSS …{{ a.cookie_summary.bduss_tail }}
                </div>
              </div>
              <a-switch
                size="small"
                :checked="a.enabled"
                @change="(v: boolean) => toggle(a, v)"
              />
            </div>

            <a-alert
              v-if="a.last_error"
              type="error"
              :message="a.last_error"
              show-icon
              class="mt-2"
              style="padding: 4px 8px"
            />

            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div class="text-xs text-slate-400">今日签到</div>
                <div>
                  <a-tag :color="checkinColor(a.checkin.last_result)">
                    {{ checkinText(a.checkin.last_result) }}
                  </a-tag>
                </div>
              </div>
              <div>
                <div class="text-xs text-slate-400">积分余额</div>
                <div>{{ a.points ? fmt(a.points.left) : '—' }}</div>
              </div>
              <div>
                <div class="text-xs text-slate-400">本月已签</div>
                <div>{{ a.checkin.sign_in_days?.length ?? '—' }} 天</div>
              </div>
              <div>
                <div class="text-xs text-slate-400">抽奖次数</div>
                <div>{{ a.lottery.remaining ?? '—' }}</div>
              </div>
            </div>

            <div class="mt-3 flex flex-wrap gap-1">
              <a-button size="small" :loading="busy[a.id]" @click="refreshStatus(a)">刷新</a-button>
              <a-button size="small" :loading="busy[a.id]" @click="checkin(a)">签到</a-button>
              <a-popconfirm
                title="确定用掉一次抽奖机会？"
                @confirm="draw(a)"
              >
                <a-button size="small" :disabled="!a.lottery.remaining">抽奖</a-button>
              </a-popconfirm>
              <a-button size="small" type="link" @click="openDetail(a)">详情</a-button>
              <a-popconfirm title="删除后需重新添加并登录" @confirm="remove(a)">
                <a-button size="small" type="link" danger>删除</a-button>
              </a-popconfirm>
            </div>
          </a-card>
        </a-col>
      </a-row>
    </a-card>

    <!-- 添加账号 -->
    <a-modal
      v-model:open="addOpen"
      title="添加账号"
      :confirm-loading="saving"
      ok-text="验证并添加"
      @ok="save"
    >
      <a-steps :current="1" size="small" class="mb-4">
        <a-step title="登录" description="浏览器打开链接登录" />
        <a-step title="复制 Cookie" description="F12 复制后粘贴" />
      </a-steps>

      <a-alert type="info" show-icon class="mb-3">
        <template #message>
          <a :href="loginUrl" target="_blank" rel="noopener" class="font-medium">
            ① 点此打开登录页 →
          </a>
        </template>
        <template #description>
          <ol class="pl-4 mb-0 mt-1 text-xs">
            <li v-for="(s, i) in loginSteps" :key="i">{{ s }}</li>
          </ol>
        </template>
      </a-alert>

      <a-form layout="vertical">
        <a-form-item label="备注名称">
          <a-input v-model:value="form.name" placeholder="留空则用账号昵称" />
        </a-form-item>
        <a-form-item label="Cookie" required>
          <a-textarea
            v-model:value="form.cookie"
            :rows="5"
            placeholder="粘贴完整 Cookie，必须包含 BDUSS=..."
          />
          <div class="text-xs text-slate-500 mt-1">
            粘贴后先点「验证」确认可用，再添加。Cookie 会明文保存在 data/ 目录。
          </div>
        </a-form-item>
        <a-form-item v-if="verifyResult">
          <a-alert
            :type="verifyResult.ok ? 'success' : 'error'"
            :message="verifyResult.ok
              ? `验证通过：${verifyResult.nickname || verifyResult.uid}`
              : `验证失败：${verifyResult.error}`"
            show-icon
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 账号详情 -->
    <a-drawer
      v-model:open="detailOpen"
      :title="`账号详情 · ${detail?.name ?? ''}`"
      width="640"
    >
      <a-spin :spinning="detailLoading">
        <template v-if="detail">
          <a-alert
            v-if="detail.expired"
            type="error"
            show-icon
            message="登录态已失效，请删除后重新添加"
            class="mb-3"
          />

          <a-descriptions title="签到" :column="2" size="small" bordered class="mb-4">
            <a-descriptions-item label="今日状态">
              <a-tag :color="detail.checkin.has_issued ? 'green' : 'orange'">
                {{ detail.checkin.has_issued ? '已签到' : '未签到' }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="累计签到">
              {{ detail.checkin.total_times ?? '—' }} 次
            </a-descriptions-item>
            <a-descriptions-item label="本月已签">
              {{ detail.checkin.sign_in_days?.length ?? 0 }} 天
            </a-descriptions-item>
            <a-descriptions-item label="本月获得">
              {{ detail.checkin.month_points ?? '—' }} 积分
            </a-descriptions-item>
          </a-descriptions>

          <div class="mb-4">
            <div class="text-sm font-medium mb-2">本月签到日历</div>
            <div class="flex flex-wrap gap-1">
              <a-tag
                v-for="d in monthDays"
                :key="d.day"
                :color="d.signed ? 'green' : 'default'"
                :title="d.day"
              >
                {{ d.label }}
              </a-tag>
            </div>
          </div>

          <a-descriptions title="积分" :column="2" size="small" bordered class="mb-4">
            <a-descriptions-item label="可用余额">
              {{ detail.points.left ?? '—' }}
            </a-descriptions-item>
            <a-descriptions-item label="累计总量">
              {{ detail.points.total ?? '—' }}
            </a-descriptions-item>
            <a-descriptions-item label="已用">
              {{ detail.points.used ?? '—' }}
            </a-descriptions-item>
            <a-descriptions-item label="限流">
              <a-tag :color="detail.points.throttled ? 'red' : 'green'">
                {{ detail.points.throttled ? '受限' : '正常' }}
              </a-tag>
            </a-descriptions-item>
          </a-descriptions>

          <a-descriptions title="抽奖" :column="2" size="small" bordered class="mb-4">
            <a-descriptions-item label="剩余次数">
              {{ detail.lottery.remaining_draws ?? 0 }}
            </a-descriptions-item>
            <a-descriptions-item label="我的奖品">
              {{ detail.lottery.my_prizes?.length ?? 0 }} 个
            </a-descriptions-item>
          </a-descriptions>

          <div v-if="detail.lottery.prizes?.length" class="mb-4">
            <div class="text-sm font-medium mb-2">奖品池</div>
            <a-table
              size="small"
              :pagination="false"
              :data-source="detail.lottery.prizes"
              :columns="prizeColumns"
              row-key="id"
            />
          </div>

          <div v-if="Array.isArray(detail.tasks) && detail.tasks.length" class="mb-4">
            <div class="text-sm font-medium mb-2">任务</div>
            <a-table
              size="small"
              :pagination="false"
              :data-source="detail.tasks"
              :columns="taskColumns"
              row-key="id"
            />
          </div>
        </template>
      </a-spin>
    </a-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import client from '@/api/client'
import type { WebAccount, AccountStatus, CheckinResult } from '@/api/webaccounts'

const accounts = ref<WebAccount[]>([])
const loginUrl = ref('')
const loginSteps = ref<string[]>([])
const addOpen = ref(false)
const detailOpen = ref(false)
const saving = ref(false)
const checkingAll = ref(false)
const detailLoading = ref(false)
const detail = ref<AccountStatus | null>(null)
const busy = reactive<Record<number, boolean>>({})
const verifyResult = ref<{ ok: boolean; nickname?: string; uid?: string; error?: string } | null>(null)

const form = reactive({ name: '', cookie: '' })

const prizeColumns = [
  { title: '奖品', key: 'name', dataIndex: 'name' },
  { title: '类型', key: 'type', dataIndex: 'type' },
]
const taskColumns = [
  { title: '任务', key: 'title', dataIndex: 'title' },
  { title: '状态', key: 'status', dataIndex: 'status' },
]

const enabledCount = computed(() => accounts.value.filter((a) => a.enabled).length)

// 本月日历：把 sign_in_days 里的日期映射到 1..今天
const monthDays = computed(() => {
  const signed = new Set(detail.value?.checkin.sign_in_days ?? [])
  const now = new Date()
  const today = now.getDate()
  const out = []
  for (let d = 1; d <= today; d++) {
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    out.push({ day: key, label: String(d), signed: signed.has(key) })
  }
  return out
})

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })

function checkinText(r: string) {
  return r === 'claimed' ? '已签到' : r === 'already' ? '今日已签' : r === 'failed' ? '签到失败' : '未签到'
}
function checkinColor(r: string) {
  return r === 'claimed' || r === 'already' ? 'green' : r === 'failed' ? 'red' : 'default'
}

async function load() {
  const { data } = await client.get('/web-accounts')
  accounts.value = data.accounts
  loginUrl.value = data.login_url
}

async function loadLoginInfo() {
  const { data } = await client.get('/web-accounts/login-url')
  loginUrl.value = data.url
  loginSteps.value = data.steps
}

function openAdd() {
  form.name = ''
  form.cookie = ''
  verifyResult.value = null
  addOpen.value = true
}

async function save() {
  if (!form.cookie.trim()) {
    message.error('请粘贴 Cookie')
    return
  }
  saving.value = true
  try {
    // 先验证再保存：避免存下一份不可用的 cookie 之后才在调用时发现
    const { data: v } = await client.post('/web-accounts/verify', { cookie: form.cookie })
    verifyResult.value = v
    if (!v.ok) {
      message.error('验证失败，未添加')
      return
    }
    await client.post('/web-accounts', {
      name: form.name || v.nickname || '',
      cookie: form.cookie,
    })
    message.success('已添加')
    addOpen.value = false
    await load()
  } catch (e: any) {
    const err = e?.response?.data
    verifyResult.value = { ok: false, error: err?.error || e.message }
    message.error(err?.error || '添加失败')
  } finally {
    saving.value = false
  }
}

async function toggle(a: WebAccount, v: boolean) {
  await client.patch(`/web-accounts/${a.id}`, { enabled: v })
  await load()
}

async function remove(a: WebAccount) {
  await client.delete(`/web-accounts/${a.id}`)
  message.success('已删除')
  await load()
}

async function checkin(a: WebAccount) {
  busy[a.id] = true
  try {
    const { data } = await client.post(`/web-accounts/${a.id}/checkin`)
    if (data.ok) message.success(data.already ? `${a.name} 今日已签到` : `${a.name} 签到成功`)
    else message.error(`${a.name} 签到失败：${data.error}`)
    await load()
  } finally {
    busy[a.id] = false
  }
}

async function checkinAll() {
  checkingAll.value = true
  try {
    const { data } = await client.post('/web-accounts/checkin-all')
    const { ok_count, fail_count } = data
    if (fail_count) message.warning(`签到完成：成功 ${ok_count}，失败 ${fail_count}`)
    else message.success(`全部签到成功（${ok_count} 个账号）`)
    await load()
  } finally {
    checkingAll.value = false
  }
}

async function draw(a: WebAccount) {
  busy[a.id] = true
  try {
    const { data } = await client.post(`/web-accounts/${a.id}/draw`, { times: 1 })
    const r = data.results?.[0]
    if (r?.ok) message.success('抽奖完成，详情里可看结果')
    else message.error(r?.error || '抽奖失败')
    await load()
  } finally {
    busy[a.id] = false
  }
}

async function refreshStatus(a: WebAccount) {
  busy[a.id] = true
  try {
    await client.get(`/web-accounts/${a.id}/status`)
    message.success('已刷新')
    await load()
  } finally {
    busy[a.id] = false
  }
}

async function openDetail(a: WebAccount) {
  detailOpen.value = true
  detailLoading.value = true
  detail.value = null
  try {
    const { data } = await client.get(`/web-accounts/${a.id}/status`)
    detail.value = data
  } finally {
    detailLoading.value = false
  }
}

onMounted(async () => {
  await Promise.all([load(), loadLoginInfo()])
})
</script>
