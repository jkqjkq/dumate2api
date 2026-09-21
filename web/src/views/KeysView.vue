<template>
  <div>
    <a-alert
      :type="data?.require_key ? 'success' : 'warning'"
      show-icon
      class="mb-4"
    >
      <template #message>
        <span v-if="data?.require_key">
          网关鉴权已开启：所有模型请求必须带已登记的 API key
        </span>
        <span v-else>
          网关鉴权当前<span class="font-medium">关闭</span>：任何来源无需 key 即可调用
        </span>
      </template>
      <template #description>
        <span v-if="!data?.require_key">
          本页的 key 与白名单已生效保存，但只有开启鉴权后才会被校验。
          开启方式：停止网关后用环境变量 <code>DUMATE_REQUIRE_KEY=1</code> 重启。
        </span>
        <span v-else>
          关闭鉴权同样需要重启网关并去掉该环境变量。
        </span>
      </template>
    </a-alert>

    <a-card :bordered="false">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="font-medium">API Key</span>
          <span class="text-slate-500 text-sm ml-2">近 {{ data?.days ?? 30 }} 天用量</span>
        </div>
        <a-button type="primary" size="small" @click="openCreate">新建 Key</a-button>
      </div>

      <a-table
        size="small"
        :pagination="false"
        :data-source="data?.keys ?? []"
        :columns="columns"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div>{{ record.name }}</div>
            <div class="text-xs text-slate-400 font-mono">{{ record.prefix }}…</div>
          </template>
          <template v-else-if="column.key === 'state'">
            <a-tag :color="stateColor(record)">{{ stateText(record) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'limits'">
            <div v-if="record.ip_allowlist.length" class="text-xs">
              IP: <span class="font-mono">{{ record.ip_allowlist.join(', ') }}</span>
            </div>
            <div v-else class="text-xs text-slate-400">IP: 不限</div>
            <div v-if="record.model_allowlist.length" class="text-xs mt-1">
              模型: <span class="font-mono">{{ record.model_allowlist.join(', ') }}</span>
            </div>
          </template>
          <template v-else-if="column.key === 'usage'">
            <div>{{ record.usage.requests }} 次</div>
            <div class="text-xs text-slate-400">{{ compact(record.usage.total_tokens) }} tokens</div>
            <a-tag v-if="record.usage.failed" color="red" class="mt-1">
              失败 {{ record.usage.failed }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'expires'">
            <span :class="record.expires_at ? '' : 'text-slate-400'">
              {{ record.expires_at ? dateText(record.expires_at) : '不过期' }}
            </span>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-space>
              <a-button type="link" size="small" @click="openEdit(record)">编辑</a-button>
              <a-switch
                size="small"
                :checked="record.enabled"
                @change="(v: boolean) => toggle(record, v)"
              />
              <a-popconfirm title="删除后无法恢复，使用该 key 的客户端会立即失败" @confirm="remove(record)">
                <a-button type="link" size="small" danger>删除</a-button>
              </a-popconfirm>
            </a-space>
          </template>
        </template>
      </a-table>

      <a-empty v-if="!data?.keys.length" description="还没有 API Key" />
    </a-card>

    <a-modal
      v-model:open="modalOpen"
      :title="editing ? '编辑 Key' : '新建 Key'"
      :confirm-loading="saving"
      @ok="save"
    >
      <a-form layout="vertical">
        <a-form-item label="名称" required>
          <a-input v-model:value="form.name" placeholder="例如 生产环境" />
        </a-form-item>
        <a-form-item label="IP 白名单">
          <a-textarea
            v-model:value="form.ipText"
            :rows="3"
            placeholder="每行一条，如 127.0.0.1 或 10.0.0.0/8；留空表示不限制"
          />
          <div class="text-xs text-slate-500 mt-1">
            写错一条会让这把 key 拒绝**所有**来源（匹配不上任何 IP），保存前会校验
          </div>
          <a-alert v-if="ipError" type="error" :message="ipError" show-icon class="mt-2" />
        </a-form-item>
        <a-form-item label="模型白名单">
          <a-select
            v-model:value="form.models"
            mode="tags"
            style="width: 100%"
            placeholder="留空表示不限制；填写后仅允许这些模型名"
            :options="modelOptions"
          />
        </a-form-item>
        <a-form-item label="有效期">
          <a-date-picker
            v-model:value="form.expiresAt"
            show-time
            style="width: 100%"
            placeholder="留空表示不过期"
          />
        </a-form-item>
        <a-form-item label="备注">
          <a-input v-model:value="form.note" placeholder="可选" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="tokenOpen"
      title="Key 已创建"
      :footer="null"
      :closable="false"
      :mask-closable="false"
    >
      <a-alert
        type="warning"
        show-icon
        message="这是唯一一次显示明文 key"
        description="离开此窗口后无法再次查看，只能重新创建。请立即复制保存。"
        class="mb-3"
      />
      <a-input-group compact>
        <a-input :value="newToken" readonly style="width: calc(100% - 80px)" />
        <a-button type="primary" style="width: 80px" @click="copyToken">复制</a-button>
      </a-input-group>
      <div class="text-right mt-4">
        <a-button @click="tokenOpen = false">我已保存</a-button>
      </div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import dayjs, { type Dayjs } from 'dayjs'
import client from '@/api/client'
import type { ApiKey, KeysData } from '@/api/keys'

const data = ref<KeysData | null>(null)
const modelOptions = ref<Array<{ label: string; value: string }>>([])
const modalOpen = ref(false)
const tokenOpen = ref(false)
const newToken = ref('')
const saving = ref(false)
const editing = ref<ApiKey | null>(null)
const ipError = ref('')

const form = reactive({
  name: '',
  ipText: '',
  models: [] as string[],
  expiresAt: null as Dayjs | null,
  note: '',
})

const columns = [
  { title: '名称', key: 'name', width: '18%' },
  { title: '状态', key: 'state', width: '10%' },
  { title: '限制', key: 'limits', width: '22%' },
  { title: '用量', key: 'usage', width: '18%' },
  { title: '有效期', key: 'expires', width: '12%' },
  { title: '操作', key: 'action', width: '20%' },
]

const compact = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)
const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN')

function stateText(k: ApiKey) {
  if (!k.enabled) return '已停用'
  if (k.expires_at && Date.now() > k.expires_at) return '已过期'
  return '启用中'
}
function stateColor(k: ApiKey) {
  if (!k.enabled) return 'default'
  if (k.expires_at && Date.now() > k.expires_at) return 'red'
  return 'green'
}

const ipList = computed(() =>
  form.ipText.split('\n').map((s) => s.trim()).filter(Boolean),
)

async function load() {
  const { data: d } = await client.get('/keys')
  data.value = d
  try {
    const { data: g } = await client.get('/models/gateway-list')
    modelOptions.value = (g.data || []).map((m: any) => ({ label: m.id, value: m.id }))
  } catch (e) { /* 网关没起也不影响 key 管理 */ }
}

function openCreate() {
  editing.value = null
  form.name = ''
  form.ipText = ''
  form.models = []
  form.expiresAt = null
  form.note = ''
  ipError.value = ''
  modalOpen.value = true
}

function openEdit(k: ApiKey) {
  editing.value = k
  form.name = k.name
  form.ipText = k.ip_allowlist.join('\n')
  form.models = [...k.model_allowlist]
  form.expiresAt = k.expires_at ? dayjs(k.expires_at) : null
  form.note = k.note || ''
  ipError.value = ''
  modalOpen.value = true
}

async function save() {
  ipError.value = ''
  if (!form.name.trim()) {
    message.error('名称不能为空')
    return
  }
  const items = ipList.value
  if (items.length) {
    const { data: check } = await client.post('/keys/check-ip', { items })
    const bad = check.results.filter((r: any) => !r.ok)
    if (bad.length) {
      ipError.value = bad.map((b: any) => b.reason).join('；')
      return
    }
  }

  const payload: any = {
    name: form.name.trim(),
    ip_allowlist: items,
    model_allowlist: form.models,
    note: form.note,
    expires_at: form.expiresAt ? form.expiresAt.valueOf() : null,
  }

  saving.value = true
  try {
    if (editing.value) {
      await client.patch(`/keys/${editing.value.id}`, payload)
      message.success('已保存')
    } else {
      const { data: created } = await client.post('/keys', payload)
      newToken.value = created.token
      tokenOpen.value = true
    }
    modalOpen.value = false
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function toggle(k: ApiKey, v: boolean) {
  await client.patch(`/keys/${k.id}`, { enabled: v })
  message.success(v ? '已启用' : '已停用')
  await load()
}

async function remove(k: ApiKey) {
  await client.delete(`/keys/${k.id}`)
  message.success('已删除')
  await load()
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(newToken.value)
    message.success('已复制到剪贴板')
  } catch (e) {
    message.warning('复制失败，请手动选中复制')
  }
}

onMounted(load)
</script>
