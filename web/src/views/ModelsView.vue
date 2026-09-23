<template>
  <div class="page">
    <PageHeader title="模型管理" sub="客户端传来的模型名 → 上游实际使用的 ID" />

    <!-- 通道视图：千问办公的模型表由上游下发，本地改不了，所以单独只读展示。
         下面的「模型映射」只描述搭子——那套别名表是搭子专用的。 -->
    <a-card v-if="qwChannel" :bordered="false">
      <template #title>
        <span class="section-title">{{ qwChannel.label }}</span>
        <a-tag class="ml-2" color="cyan">只读</a-tag>
      </template>
      <template #extra>
        <span class="text-xs text-slate-400">模型表由上游下发，本地不可编辑</span>
      </template>
      <a-empty v-if="!qwChannel.models.length" :description="qwChannel.error || '未取到模型列表'" />
      <a-space v-else wrap :size="[8, 8]">
        <a-tag v-for="m in qwChannel.models" :key="m.id" color="cyan" class="qw-model-tag">
          <span class="font-medium">{{ m.name }}</span>
          <span class="font-mono text-xs ml-2 opacity-70">{{ m.prefixed }}</span>
        </a-tag>
      </a-space>
      <div class="text-xs text-slate-500 mt-3">
        调用时用前缀名（如 <span class="font-mono">qwen/{{ qwChannel.models[0]?.id || 'pro' }}</span>）；
        不带前缀的名字一律走搭子。
      </div>
    </a-card>

    <a-card :bordered="false" class="mt-4">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="section-title">模型映射</span>
        </div>
        <a-space>
          <a-button size="small" :loading="probing" @click="probeAll">探测上游</a-button>
          <a-button size="small" @click="addAlias">新增别名</a-button>
          <a-popconfirm title="恢复为默认映射？当前改动会丢失" @confirm="reset">
            <a-button size="small" danger>恢复默认</a-button>
          </a-popconfirm>
          <a-button type="primary" size="small" :loading="saving" @click="save">保存</a-button>
        </a-space>
      </div>

      <a-alert
        type="info"
        show-icon
        class="mb-3"
        message="上游没有模型列表接口，只能逐个探测。探测会向上游发一个 1 token 的最小请求。"
      />

      <a-table
        size="small"
        :pagination="false"
        :data-source="rows"
        :columns="columns"
        row-key="name"
      >
        <template #bodyCell="{ column, record, index }">
          <template v-if="column.key === 'name'">
            <a-input v-model:value="record.name" size="small" placeholder="客户端模型名" />
          </template>
          <template v-else-if="column.key === 'target'">
            <a-select
              v-model:value="record.target"
              size="small"
              style="width: 100%"
              :options="targetOptions"
            />
          </template>
          <template v-else-if="column.key === 'native'">
            <a-tag v-if="record.upstream_native" color="green">上游原生</a-tag>
            <a-tag v-else color="default">别名转换</a-tag>
          </template>
          <template v-else-if="column.key === 'probe'">
            <template v-if="probeMap[record.name]">
              <a-tag v-if="probeMap[record.name].ok" color="green">接受</a-tag>
              <a-tooltip v-else :title="probeMap[record.name].error">
                <a-tag color="red">{{ probeMap[record.name].status || '错误' }}</a-tag>
              </a-tooltip>
            </template>
            <span v-else class="text-slate-400 text-xs">—</span>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-button type="link" size="small" danger @click="removeRow(index)">删除</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="12">
        <a-card title="上游原生模型" :bordered="false">
          <div class="text-xs text-slate-500 mb-2">
            上游直接认识的 ID，无需转换。名称错误时上游会返回 404。
          </div>
          <a-tag v-for="m in upstreamModels" :key="m" color="green" class="mb-1">{{ m }}</a-tag>
        </a-card>
      </a-col>
      <a-col :span="12">
        <a-card title="对外暴露给客户端" :bordered="false">
          <div class="text-xs text-slate-500 mb-2">
            网关 /v1/models 返回的条目，Codex 与 Claude Code 从这里选模型。
          </div>
          <a-tag v-for="m in exposed" :key="m" color="blue" class="mb-1">{{ m }}</a-tag>
          <div class="text-xs text-slate-400 mt-2">默认回落模型：{{ map?.fallback }}</div>
        </a-card>
      </a-col>
    </a-row>

    <a-card title="网关实际返回" :bordered="false" class="mt-4">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-slate-500">直接读取 9080 的 /v1/models，确认改动已生效</span>
        <a-button size="small" :loading="loadingGateway" @click="loadGateway">刷新</a-button>
      </div>
      <a-table
        size="small"
        :pagination="false"
        :data-source="gatewayList"
        :columns="gatewayColumns"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'owned'">
            <a-tag :color="record.owned_by === 'dumate' ? 'green' : 'default'">
              {{ record.owned_by === 'dumate' ? '上游原生' : '代理转换' }}
            </a-tag>
          </template>
        </template>
      </a-table>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { message } from 'ant-design-vue'
import client from '@/api/client'
import type { ModelMapData, ProbeResult } from '@/api/models'

interface Row {
  name: string
  target: string
  upstream_native: boolean
}

const map = ref<ModelMapData | null>(null)
// 千问办公通道（只读）。从 /models/map 的 channels 里取，不另开接口。
const qwChannel = computed(() => map.value?.channels?.find((c) => c.id === 'qwenwork') || null)
const rows = ref<Row[]>([])
const saving = ref(false)
const probing = ref(false)
const loadingGateway = ref(false)
const probeMap = ref<Record<string, ProbeResult>>({})
const gatewayList = ref<Array<{ id: string; owned_by: string }>>([])
const upstreamModels = ref<string[]>([])
const exposed = ref<string[]>([])

const columns = [
  { title: '客户端模型名', key: 'name', width: '28%' },
  { title: '映射到', key: 'target', width: '24%' },
  { title: '类型', key: 'native', width: '16%' },
  { title: '探测结果', key: 'probe', width: '16%' },
  { title: '操作', key: 'action', width: '10%' },
]
const gatewayColumns = [
  { title: '模型 ID', key: 'id', dataIndex: 'id' },
  { title: '来源', key: 'owned' },
]

// 目标只允许选上游原生 ID：选一个上游不认的名字，请求会在上游 404，
// 而这正是「别名」要避免的事。
const targetOptions = computed(() =>
  upstreamModels.value.map((m) => ({ label: m, value: m })),
)

async function load() {
  const { data } = await client.get('/models/map')
  map.value = data
  upstreamModels.value = data.upstream_models
  exposed.value = data.exposed
  rows.value = data.entries.map((e: any) => ({
    name: e.name,
    target: e.target,
    upstream_native: e.upstream_native,
  }))
}

async function loadGateway() {
  loadingGateway.value = true
  try {
    const { data } = await client.get('/models/gateway-list')
    gatewayList.value = data.data || []
  } finally {
    loadingGateway.value = false
  }
}

function addAlias() {
  rows.value.unshift({ name: '', target: upstreamModels.value[0] || '', upstream_native: false })
}

function removeRow(index: number) {
  rows.value.splice(index, 1)
}

async function save() {
  const aliases: Record<string, string> = {}
  for (const r of rows.value) {
    const name = r.name.trim()
    if (!name) {
      message.error('存在空的模型名')
      return
    }
    aliases[name] = r.target
  }
  saving.value = true
  try {
    await client.post('/models/map', {
      aliases,
      upstream_models: upstreamModels.value,
      exposed: exposed.value,
    })
    message.success('已保存，网关会在下次请求时读取')
    await load()
    await loadGateway()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function probeAll() {
  const models = Array.from(new Set(upstreamModels.value.concat(rows.value.map((r) => r.name.trim()).filter(Boolean))))
  if (!models.length) return
  probing.value = true
  try {
    const { data } = await client.post('/models/probe', { models: models.slice(0, 20) })
    const next: Record<string, ProbeResult> = {}
    for (const r of data.results as ProbeResult[]) next[r.model] = r
    probeMap.value = next
    message.success(`已探测 ${data.results.length} 个模型`)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '探测失败')
  } finally {
    probing.value = false
  }
}

async function reset() {
  await client.post('/models/map/reset')
  message.success('已恢复默认映射')
  await load()
  await loadGateway()
}

onMounted(async () => {
  await load()
  await loadGateway()
})
</script>
