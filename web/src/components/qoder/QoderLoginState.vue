<template>
  <div class="page">
    <PageHeader title="登录态" :sub="subText">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
    </PageHeader>

    <!-- 与千问/TRAE 的差异写清楚：Qoder 连 wasm 都不需要 -->
    <a-alert type="info" show-icon>
      <template #message>凭证由本项目持有，且不需要任何客户端</template>
      <template #description>
        <div>
          Qoder 的凭证存在 <code>data/qoder-accounts.json</code>，是本项目走
          <b>device flow</b> 自取的。access token 到期时网关用 refresh token 自动换新，
          <b>不需要打开 Qoder 客户端</b>。
        </div>
        <div class="mt-1">
          与千问办公的关键差异：千问的请求体必须由官方 <code>wasm</code> 生成（所以要装客户端），
          而 Qoder 的签名是<b>纯本地算法</b>（RSA + AES + MD5），不依赖任何客户端安装。
        </div>
      </template>
    </a-alert>

    <a-alert
      v-if="status && !status.ready"
      type="warning"
      show-icon
      :message="status.error || '通道不可用'"
    />

    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="8">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="可用账号" :value="status?.accounts ?? '—'">
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            共 {{ rows.length }} 个 · 停用 {{ rows.length - enabledCount }} 个
          </div>
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card :bordered="false" class="h-full">
          <a-statistic
            title="通道状态"
            :value="status?.ready ? '就绪' : '不可用'"
            :value-style="status?.ready ? 'color:#34d399' : 'color:#f87171'"
          />
          <div class="text-xs text-slate-500 mt-2">
            {{ status?.ready ? '至少有一个启用且凭证完整的账号' : (status?.error || '—') }}
          </div>
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card :bordered="false" class="h-full">
          <a-statistic
            title="最近到期"
            :value="soonestText"
            :value-style="soonestSoon ? 'color:#fbbf24' : undefined"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="soonestAt">access token 最早到期的账号</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-alert
      v-if="anyRefreshExpired"
      type="warning"
      show-icon
      class="mt-4"
      message="有账号的 refresh token 已过期"
      description="access token 到期后无法自动续期，该账号会失效。请到「账号管理」删除后重新登录。"
    />

    <a-card title="账号凭证" :bordered="false" class="mt-4">
      <a-empty v-if="!rows.length" description="还没有 Qoder 账号">
        <a-button type="primary" @click="goAccounts">去添加账号</a-button>
      </a-empty>
      <a-table
        v-else
        size="small"
        :pagination="false"
        :data-source="rows"
        :columns="columns"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div>{{ record.nickname || '未命名' }}</div>
            <div class="text-xs text-slate-400 font-mono">UID {{ record.uid || '—' }}</div>
            <div v-if="record.phoneMasked" class="text-xs text-slate-500 font-mono">
              {{ record.phoneMasked }}
            </div>
          </template>
          <template v-else-if="column.key === 'region'">
            <a-tag :color="record.region === 'cn' ? 'blue' : 'purple'">
              {{ record.region === 'cn' ? '国内' : '国际' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'plan'">
            {{ record.planName || '—' }}
          </template>
          <template v-else-if="column.key === 'enabled'">
            <a-tag :color="record.enabled ? 'green' : 'default'">
              {{ record.enabled ? '启用' : '停用' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'access'">
            <a-tag :color="expired(record.expiresAt) ? 'red' : 'green'">
              {{ expired(record.expiresAt) ? '已过期' : '有效' }}
            </a-tag>
            <div class="text-xs text-slate-400 mt-1">
              {{ record.expiresAt ? dateText(record.expiresAt) : '—' }}
            </div>
          </template>
          <template v-else-if="column.key === 'refresh'">
            <a-tag :color="expired(record.refreshExpiresAt) ? 'red' : 'green'">
              {{ expired(record.refreshExpiresAt) ? '已过期' : '有效' }}
            </a-tag>
            <div class="text-xs text-slate-400 mt-1">
              {{ record.refreshExpiresAt ? dateText(record.refreshExpiresAt) : '—' }}
            </div>
          </template>
          <template v-else-if="column.key === 'refreshTail'">
            <span class="font-mono text-xs">…{{ record.refreshTail || '—' }}</span>
          </template>
          <template v-else-if="column.key === 'err'">
            <span v-if="record.lastError" :class="errFresh(record) ? 'text-xs text-red-500' : 'text-xs text-slate-500'">
              <span class="text-slate-500">{{ errTime(record.lastErrorAt) }}</span>{{ record.lastError }}
            </span>
            <span v-else class="text-slate-400">—</span>
          </template>
        </template>
      </a-table>
      <div class="text-xs text-slate-400 mt-2">
        refresh token 只显示尾部 6 位用于人工核对，全量不外传。
        国内（qoder.com.cn）与国际（qoder.sh）账号不通用，各存各的。
      </div>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import { channelStore, isQoder } from '@/stores/channel'
import { qoderApi } from '@/api/qoder'
import type { QoderStatus, QoderAccount } from '@/api/qoder'
import { lastErrorFresh, errorWhen } from '@/utils/lastError'

const router = useRouter()
const status = ref<QoderStatus | null>(null)
const loading = ref(false)

const rows = computed(() => status.value?.rows ?? [])
const enabledCount = computed(() => rows.value.filter((a) => a.enabled).length)

const subText = computed(() =>
  status.value?.ready ? 'Qoder 登录态与 token 到期（凭证自持，无需客户端）' : 'Qoder 登录态 · 不可用')

const expired = (ts: number | null) => !!ts && Date.now() >= ts
const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })
// lastError 的新鲜度判定收敛在 utils/lastError（无时间戳=陈旧）
const errFresh = (a: QoderAccount) => lastErrorFresh(a)
const errTime = (ts: number | null) => errorWhen(ts)

const soonestAt = computed(() => {
  const list = rows.value.filter((a) => a.enabled && a.expiresAt)
  if (!list.length) return null
  return Math.min(...list.map((a) => a.expiresAt as number))
})
const soonestText = computed(() => (soonestAt.value ? dateText(soonestAt.value) : '—'))
const soonestSoon = computed(
  () => !!soonestAt.value && soonestAt.value - Date.now() < 24 * 3600 * 1000,
)
const anyRefreshExpired = computed(
  () => rows.value.some((a) => a.enabled && expired(a.refreshExpiresAt)),
)

const columns = [
  { title: '账号', key: 'name', width: '18%' },
  { title: '区域', key: 'region', width: '8%' },
  { title: '套餐', key: 'plan', width: '10%' },
  { title: '状态', key: 'enabled', width: '8%' },
  { title: 'access token', key: 'access', width: '16%' },
  { title: 'refresh token', key: 'refresh', width: '16%' },
  { title: 'refresh 尾', key: 'refreshTail', width: '8%' },
  { title: '最近错误', key: 'err' },
]

function goAccounts() {
  router.push('/web-accounts')
}

async function load() {
  loading.value = true
  try {
    const { data } = await qoderApi.status()
    status.value = data
  } catch (e: any) {
    status.value = {
      ready: false, error: e?.response?.data?.error || e?.message || '读取失败',
      accounts: 0, needsClient: false, mode: 'multi', modeNote: '', rows: [],
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => channelStore.current, (v) => { if (isQoder(v)) load() })
</script>
