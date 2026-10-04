<!-- web/src/components/CcSwitchDialog.vue - 「配置到 cc-switch」弹窗

     设计要点：**把推导依据摊开给人看**，而不是丢一个数字。
     上下文/输出上限都是「取所选模型的最小值」，界面上同时显示每个模型的
     原始值、来源（上游下发/实测/配置）、以及是哪个模型决定了最终结果——
     用户看到 160768 这种数字时能立刻明白是哪个模型拖下来的，并自己改勾选。
-->
<script setup lang="ts">
import { ref, computed, h } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { CHANNELS } from '@/stores/channel'
import { ccswitchApi, type CcPreview, type CcApplyResult } from '@/api/ccswitch'

const open = ref(false)
const channel = ref('dumate')
const app = ref<'claude' | 'codex'>('claude')
const loading = ref(false)
const data = ref<CcPreview | null>(null)
/** 手动勾选的模型 id；为空表示采用后端默认（倍率最低的 4 个） */
const picked = ref<string[]>([])
const token = ref('')
const applying = ref(false)
const applyResult = ref<CcApplyResult | null>(null)

const models = computed(() => data.value?.all_models || [])
const derived = computed(() => data.value?.derived || null)

const configText = computed(() => {
  if (!data.value) return ''
  if (app.value === 'claude') return JSON.stringify(data.value.claude_env, null, 2)
  const cat = JSON.stringify({ models: data.value.codex_catalog }, null, 2)
  return `${data.value.codex_config}\n\n# modelCatalog（cc-switch 用它渲染模型列表）\n${cat}`
})

const srcLabel = (s: string) =>
  s === 'upstream' ? '上游' : s === 'measured' ? '实测' : s === 'config' ? '配置' : '—'

async function load() {
  loading.value = true
  try {
    const { data: d } = await ccswitchApi.preview({
      channel: channel.value,
      app: app.value,
      models: picked.value,
      token: token.value.trim() || undefined,
    })
    data.value = d
  } catch (e: any) {
    message.error(e?.response?.data?.error || '生成失败')
    data.value = null
  } finally {
    loading.value = false
  }
}

function openDialog(ch?: string) {
  if (ch) channel.value = ch
  picked.value = []
  open.value = true
  load()
}

function toggle(id: string, checked: boolean) {
  const next = new Set(picked.value)
  if (checked) next.add(id)
  else next.delete(id)
  // 第一次手动勾选时，把后端默认选中的也带上，避免「一勾就只剩一个」
  if (picked.value.length === 0) {
    for (const m of models.value) if (m.picked) next.add(m.id)
  }
  picked.value = [...next]
  load()
}

function resetPick() {
  picked.value = []
  load()
}

async function copyConfig() {
  try {
    await navigator.clipboard.writeText(configText.value)
    message.success('配置已复制')
  } catch (e) {
    message.warning('复制失败，请手动选中复制')
  }
}

/** 写入前的确认：把「要写什么、会动到 cc-switch 什么」摊开说清 */
function confirmApply(): Promise<boolean> {
  const d = data.value
  const tierLine = (d?.tiers || []).map((t) => `${t.tier}=${t.name}`).join('   ')
  const lines = [
    `通道　${d?.channel_label || channel.value}　　应用　${app.value === 'claude' ? 'Claude Code' : 'Codex'}`,
    `档位　${tierLine || '（默认）'}`,
    `上下文 ${d?.derived.context_window ?? '?'}（压缩线 ${d?.derived.compact_limit ?? '?'}）　输出上限 ${d?.derived.max_output ?? '?'}`,
    `网关　${d?.gateway || ''}`,
    '',
    '写入 cc-switch 的供应商列表（幂等：同 id 更新；写前自动备份）。',
    '不会关闭正在运行的 cc-switch（实测它运行中不写库，直接写是安全的）；',
    '但它只在启动时读库，所以新供应商要重启它才会出现在列表里。',
  ]
  return new Promise((resolve) => {
    Modal.confirm({
      title: '确认添加到 cc-switch',
      content: h('div', { style: 'white-space:pre-line;font-size:13px;line-height:1.7' }, lines.join('\n')),
      okText: '确认写入',
      cancelText: '取消',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
}

/**
 * 直接写进 cc-switch。
 *
 * 流程：**先确认 → 写库 → 自动启动 cc-switch**。
 * 无论 cc-switch 是否在运行都先弹确认——用户该知道要写什么、会不会动到他
 * 正在用的 cc-switch。它内存优先（运行时界面上所有操作都基于内存那份，
 * 退出时写回），所以运行中必须先关它再写，否则改动会被覆盖。
 */
async function applyToCcSwitch() {
  if (!data.value) {
    message.warning('先选择通道生成配置')
    return
  }
  if (!(await confirmApply())) return
  applying.value = true
  try {
    const res = await ccswitchApi.apply({
      channel: channel.value,
      app: app.value,
      models: picked.value,
      token: token.value.trim() || undefined,
      confirmed: true,
    })
    const r = res.data
    if (r.ok) {
      applyResult.value = r
      if (r.need_manual_restart) {
        // 在运行时写库：它内存里没有这条记录，重启才可见（不替用户关它）
        message.warning(`已写入 ${r.name}。cc-switch 正在运行，它只在启动时读库——重启一次就能在列表里看到。`, 8)
      } else {
        message.success(`已写入 cc-switch：${r.name}${r.updated ? '（更新）' : ''}${r.started ? '，并已启动' : ''}`)
      }
    } else {
      message.error(r.error || r.message || '写入失败')
    }
  } catch (e: any) {
    message.error(e?.response?.data?.error || e?.message || '写入失败')
  } finally {
    applying.value = false
  }
}

const columns = [
  { key: 'pick', title: '', width: 40 },
  { key: 'model', title: '模型', width: 240 },
  { key: 'rate', title: '倍率', width: 70 },
  { key: 'ctx', title: '上下文', width: 190 },
  { key: 'out', title: '输出上限', width: 150 },
]

defineExpose({ openDialog })
</script>

<template>
  <a-modal v-model:open="open" title="配置到 cc-switch" width="980px" :footer="null" destroy-on-close>
    <a-space wrap class="mb-3">
      <a-radio-group v-model:value="channel" button-style="solid" @change="() => { picked = []; load() }">
        <a-radio-button v-for="c in CHANNELS" :key="c.id" :value="c.id">{{ c.label }}</a-radio-button>
      </a-radio-group>
      <a-radio-group v-model:value="app" button-style="solid" @change="load">
        <a-radio-button value="claude">Claude Code</a-radio-button>
        <a-radio-button value="codex">Codex</a-radio-button>
      </a-radio-group>
      <a-input v-model:value="token" placeholder="API Key（网关未开鉴权可留空）" style="width: 240px" @blur="load" />
    </a-space>

    <a-spin :spinning="loading">
      <template v-if="derived">
        <a-descriptions size="small" bordered :column="3" class="mb-2">
          <a-descriptions-item label="声明上下文">
            {{ derived.context_window ?? '—' }}
            <a-tag :color="derived.context_source === 'upstream' ? 'green' : 'orange'" class="ml-1">
              {{ srcLabel(derived.context_source) }}
            </a-tag>
          </a-descriptions-item>
          <a-descriptions-item label="压缩线（85%）">{{ derived.compact_limit ?? '—' }}</a-descriptions-item>
          <a-descriptions-item label="输出上限">
            {{ derived.max_output ?? '—' }}
            <a-tag :color="derived.max_output_source === 'upstream' ? 'green' : 'orange'" class="ml-1">
              {{ srcLabel(derived.max_output_source) }}
            </a-tag>
          </a-descriptions-item>
          <a-descriptions-item label="由哪个模型决定" :span="3">
            上下文 ← <code>{{ derived.context_owner || '—' }}</code>
            ；输出 ← <code>{{ derived.max_output_owner || '—' }}</code>
          </a-descriptions-item>
        </a-descriptions>

        <a-alert type="info" show-icon class="mb-2" :message="derived.rule" />
        <a-alert
          v-for="(w, i) in data?.warnings || []"
          :key="i"
          type="warning"
          show-icon
          class="mb-1"
          :message="w"
        />

        <div class="flex items-center justify-between mt-3 mb-1">
          <span class="text-xs opacity-70">
            勾选要映射到档位的模型（默认取倍率最低的 4 个）。取消勾选可排除拖低下限的模型。
          </span>
          <a-button size="small" type="link" @click="resetPick">恢复默认</a-button>
        </div>
        <a-table
          :columns="columns"
          :data-source="models"
          row-key="id"
          size="small"
          :pagination="{ pageSize: 8, size: 'small' }"
          :scroll="{ y: 240 }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'pick'">
              <a-checkbox
                :checked="picked.length ? picked.includes(record.id) : record.picked"
                @change="(e: any) => toggle(record.id, e.target.checked)"
              />
            </template>
            <template v-else-if="column.key === 'model'">
              <div>{{ record.name }}</div>
              <div class="text-xs opacity-60">{{ record.prefixed }}</div>
            </template>
            <template v-else-if="column.key === 'rate'">
              {{ record.rate ?? '—' }}
            </template>
            <template v-else-if="column.key === 'ctx'">
              {{ record.contextWindow ?? '—' }}
              <a-tag v-if="record.contextWindowMin" color="orange" class="ml-1">
                区间下界 {{ record.contextWindowMin }}
              </a-tag>
              <a-tag :color="record.contextSource === 'upstream' ? 'green' : 'orange'" class="ml-1">
                {{ srcLabel(record.contextSource) }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'out'">
              {{ record.maxTokens ?? '—' }}
              <a-tag :color="record.maxTokensSource === 'upstream' ? 'green' : 'orange'" class="ml-1">
                {{ srcLabel(record.maxTokensSource) }}
              </a-tag>
            </template>
          </template>
        </a-table>

        <div class="flex items-center justify-between mt-3 mb-1">
          <span class="text-xs opacity-70">
            直接写进 cc-switch 的供应商列表（幂等：同 id 更新；写前自动备份；cc-switch 在运行会先关它再自动启动）
          </span>
          <a-space>
            <a-button size="small" @click="copyConfig">复制配置</a-button>
            <a-button type="primary" size="small" :loading="applying" @click="applyToCcSwitch">
              添加到 cc-switch
            </a-button>
          </a-space>
        </div>
        <a-alert v-if="applyResult" type="success" show-icon class="mb-2">
          <template #message>
            已写入 {{ applyResult.name }}（<code>{{ applyResult.id }}</code>）{{ applyResult.updated ? '，更新了已有配置' : '' }}
          </template>
          <template #description>
            备份 {{ applyResult.backup || '—' }}；
            <template v-if="applyResult.need_manual_restart">
              cc-switch 正在运行，<b>重启它</b>就能在列表里看到（没有替你关它）
            </template>
            <template v-else>{{ applyResult.started ? 'cc-switch 已自动启动' : '请手动启动 cc-switch' }}</template>
            <span v-if="applyResult.account_note">；模型来自 {{ applyResult.account_note }}</span>
          </template>
        </a-alert>
        <a-textarea :value="configText" readonly :rows="12" style="font-family: ui-monospace, monospace" />
      </template>
      <a-empty v-else description="选择通道后生成配置" />
    </a-spin>
  </a-modal>
</template>
