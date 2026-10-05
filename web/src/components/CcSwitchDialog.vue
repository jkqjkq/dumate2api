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
import { ccswitchApi, type CcPreview, type CcApplyResult, type CcOpenResult } from '@/api/ccswitch'

const open = ref(false)
const channel = ref('dumate')
const app = ref<'claude' | 'codex'>('claude')
const loading = ref(false)
const data = ref<CcPreview | null>(null)
/** 手动勾选的模型 id；为空表示采用后端默认（倍率最低的 4 个） */
const picked = ref<string[]>([])
const token = ref('')
const applying = ref(false)
const opening = ref(false)
const applyResult = ref<CcApplyResult | null>(null)
const openResult = ref<CcOpenResult | null>(null)

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

/** 千分位——256000 这种数字不加分隔符会读成 2560 或 2560000 */
const fmt = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US')

async function load() {
  loading.value = true
  openResult.value = null
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

/**
 * 首选路径：唤起 cc-switch，由它弹自己的「确认导入」框。
 * 配置已在链接里预填，用户在 cc-switch 里自己决定加不加——本端不写它的库。
 */
async function openInCcSwitch() {
  if (!data.value) {
    message.warning('先选择通道生成配置')
    return
  }
  opening.value = true
  try {
    const res = await ccswitchApi.open({
      channel: channel.value,
      app: app.value,
      models: picked.value,
      token: token.value.trim() || undefined,
    })
    const r = res.data
    if (r.ok) {
      openResult.value = r
      message.success(
        r.running
          ? `已唤起 cc-switch，请在它弹出的「确认导入」框中查看并确认：${r.name}`
          : `已启动 cc-switch 并准备好配置，请在「确认导入」框中确认：${r.name}`,
        7,
      )
    } else {
      message.error(r.error || '唤起 cc-switch 失败')
    }
  } catch (e: any) {
    message.error(e?.response?.data?.error || e?.message || '唤起失败')
  } finally {
    opening.value = false
  }
}

function openDialog(ch?: string) {
  if (ch) channel.value = ch
  picked.value = []
  applyResult.value = null
  openResult.value = null
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

async function copyDeepLink() {
  const url = openResult.value?.url || data.value?.deeplink || ''
  if (!url) {
    message.warning('还没有可复制的链接')
    return
  }
  try {
    await navigator.clipboard.writeText(url)
    message.success('deep link 已复制，可粘到运行框或浏览器地址栏唤起')
  } catch (e) {
    message.warning('复制失败，请手动复制')
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
  { key: 'pick', title: '', width: 44 },
  { key: 'model', title: '模型' },
  { key: 'rate', title: '倍率', width: 72 },
  { key: 'ctx', title: '上下文', width: 132 },
  { key: 'out', title: '输出上限', width: 124 },
]

defineExpose({ openDialog })
</script>

<template>
  <a-modal v-model:open="open" title="配置到 cc-switch" width="980px" :footer="null" destroy-on-close>
    <!-- 顶部工具条：独占一行并带下分隔线，避免和下方内容糊在一起 -->
    <div class="cc-toolbar">
      <a-space wrap size="middle">
        <div class="cc-field">
          <span class="cc-field-label">通道</span>
          <a-radio-group v-model:value="channel" button-style="solid" size="small" @change="() => { picked = []; load() }">
            <a-radio-button v-for="c in CHANNELS" :key="c.id" :value="c.id">{{ c.label }}</a-radio-button>
          </a-radio-group>
        </div>
        <div class="cc-field">
          <span class="cc-field-label">应用</span>
          <a-radio-group v-model:value="app" button-style="solid" size="small" @change="load">
            <a-radio-button value="claude">Claude Code</a-radio-button>
            <a-radio-button value="codex">Codex</a-radio-button>
          </a-radio-group>
        </div>
        <div class="cc-field">
          <span class="cc-field-label">API Key</span>
          <a-input v-model:value="token" size="small" placeholder="网关未开鉴权可留空" style="width: 220px" @blur="load" />
        </div>
      </a-space>
    </div>

    <a-spin :spinning="loading">
      <div v-if="derived" class="cc-body">
        <!-- 1. 结论区：三个推导结果并排，各自带来源标签 -->
        <section class="cc-section">
          <div class="cc-section-head">推导结果</div>
          <div class="cc-metrics">
            <div class="cc-metric">
              <div class="cc-metric-label">声明上下文</div>
              <div class="cc-metric-value num">{{ fmt(derived.context_window) }}</div>
              <a-tag :color="derived.context_source === 'upstream' ? 'green' : 'orange'" class="cc-src">
                {{ srcLabel(derived.context_source) }}
              </a-tag>
            </div>
            <div class="cc-metric">
              <div class="cc-metric-label">压缩线 85%</div>
              <div class="cc-metric-value num">{{ fmt(derived.compact_limit) }}</div>
              <div class="cc-metric-sub">到这个量自动压缩</div>
            </div>
            <div class="cc-metric">
              <div class="cc-metric-label">输出上限</div>
              <div class="cc-metric-value num">{{ fmt(derived.max_output) }}</div>
              <a-tag :color="derived.max_output_source === 'upstream' ? 'green' : 'orange'" class="cc-src">
                {{ srcLabel(derived.max_output_source) }}
              </a-tag>
            </div>
          </div>
          <div class="cc-owner">
            由模型决定：上下文 ←
            <code>{{ derived.context_owner || '—' }}</code>
            ；输出 ←
            <code>{{ derived.max_output_owner || '—' }}</code>
          </div>
          <div class="cc-rule">{{ derived.rule }}</div>
        </section>

        <!-- 2. 提醒区：合并成一条带列表的 alert，不再每个 warning 一张卡 -->
        <section v-if="(data?.warnings || []).length" class="cc-section">
          <a-alert type="warning" show-icon>
            <template #message>添加前请注意（{{ (data?.warnings || []).length }} 条）</template>
            <template #description>
              <ul class="cc-warn-list">
                <li v-for="(w, i) in data?.warnings || []" :key="i">{{ w }}</li>
              </ul>
            </template>
          </a-alert>
        </section>

        <!-- 3. 档位选择 -->
        <section class="cc-section">
          <div class="cc-section-head">
            <span>档位模型</span>
            <span class="cc-section-sub">默认取倍率最低的 4 个；取消勾选可排除拖低下限的模型</span>
            <a-button size="small" type="link" @click="resetPick">恢复默认</a-button>
          </div>
          <a-table
            :columns="columns"
            :data-source="models"
            row-key="id"
            size="small"
            :pagination="{ pageSize: 8, size: 'small' }"
            :scroll="{ x: 720 }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'pick'">
                <a-checkbox
                  :checked="picked.length ? picked.includes(record.id) : record.picked"
                  @change="(e: any) => toggle(record.id, e.target.checked)"
                />
              </template>
              <template v-else-if="column.key === 'model'">
                <div class="cc-model-name">{{ record.name }}</div>
                <div class="cc-model-id mono">{{ record.prefixed }}</div>
              </template>
              <template v-else-if="column.key === 'rate'">
                <span class="num">{{ record.rate ?? '—' }}</span>
              </template>
              <!-- 数值与来源标签分两层：挤在一行会连成数字串 -->
              <template v-else-if="column.key === 'ctx'">
                <div class="num">
                  <template v-if="record.contextWindowMin && record.contextWindowMin !== record.contextWindow">
                    {{ record.contextWindowMin }} ~ {{ record.contextWindow }}
                  </template>
                  <template v-else>{{ record.contextWindow ?? '—' }}</template>
                </div>
                <div class="cc-cell-src">
                  <span class="src-tag">{{ srcLabel(record.contextSource) }}</span>
                  <span v-if="record.contextWindowMin" class="src-tag src-tag-warn">取下界</span>
                </div>
              </template>
              <template v-else-if="column.key === 'out'">
                <div class="num">{{ record.maxTokens ?? '—' }}</div>
                <div class="cc-cell-src">
                  <span class="src-tag">{{ srcLabel(record.maxTokensSource) }}</span>
                </div>
              </template>
            </template>
          </a-table>
        </section>

        <!-- 4. 操作区：说明与按钮分两行，按钮右对齐 -->
        <section class="cc-section cc-action">
          <div class="cc-action-hint">
            点击后打开 cc-switch，由它弹出「确认导入」框并预填配置——是否添加由你决定，本端不直接改它的库。
          </div>
          <div class="cc-action-btns">
            <a-button size="small" @click="copyConfig">复制配置文本</a-button>
            <a-button type="primary" :loading="opening" @click="openInCcSwitch">
              在 cc-switch 中打开
            </a-button>
          </div>
        </section>

        <a-alert v-if="openResult && openResult.ok" type="success" show-icon class="cc-section">
          <template #message>已唤起 cc-switch：{{ openResult.name }}</template>
          <template #description>
            <div class="cc-open-line">
              请在 cc-switch 弹出的<b>「确认导入」</b>对话框里核对配置，点「导入」才会添加、点取消则什么都不做。
              <span v-if="openResult.running">若它已在前台但没弹窗，请留意任务栏。</span>
            </div>
            <a-button type="link" size="small" class="cc-link-btn" @click="copyDeepLink">复制 deep link（备用）</a-button>
          </template>
        </a-alert>

        <!-- 5. 高级：收起，避免它的说明文字参与主流程的拥挤 -->
        <details class="cc-adv">
          <summary>高级：直接写入 cc-switch 数据库（不经确认框）</summary>
          <div class="cc-adv-body">
            <a-alert
              v-if="app === 'codex'"
              type="warning"
              show-icon
              message="Codex 建议用这个：deep link 带不进上下文窗口与模型目录，直接写入会原样保留完整 config.toml + modelCatalog。"
            />
            <div class="cc-action">
              <div class="cc-action-hint">
                幂等（同 id 更新）；写前自动备份；cc-switch 正在运行时写入后需重启它才显示。
              </div>
              <a-button :loading="applying" @click="applyToCcSwitch">直接写入</a-button>
            </div>
            <a-alert v-if="applyResult" type="success" show-icon>
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
          </div>
        </details>

        <!-- 6. 配置预览：可折叠，默认收起以减少首屏信息量 -->
        <details class="cc-adv">
          <summary>配置预览（{{ app === 'claude' ? 'Claude env' : 'Codex config.toml' }}）</summary>
          <a-textarea :value="configText" readonly :rows="12" class="cc-code" />
        </details>
      </div>
      <a-empty v-else description="选择通道后生成配置" />
    </a-spin>
  </a-modal>
</template>

<style scoped>
/* ============================================================
   分区布局：整块内容按「结论 / 提醒 / 档位 / 操作」分区，
   区间距由 .cc-body 的 gap 统一负责——逐块写 mt/mb 会和 gap
   叠成双倍，且各块疏密必然不一致（这次拥挤的直接原因）。
   ============================================================ */
.cc-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.cc-section {
  margin: 0;
}

/* 顶部工具条：与下方内容用发丝线切开，不再靠 margin 拉开 */
.cc-toolbar {
  padding-bottom: 14px;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--lab-border);
}
.cc-field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cc-field-label {
  font-size: 11.5px;
  letter-spacing: 0.4px;
  color: var(--lab-text-mute);
  white-space: nowrap;
}

/* 小节标题：标题、说明、动作各归其位，不再全挤在一行两端 */
.cc-section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--lab-text);
}
.cc-section-sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--lab-text-mute);
}
.cc-section-head .ant-btn-link {
  margin-left: auto;
  padding: 0;
  height: auto;
}

/* 三个推导结果并排：数字用等宽 + 千分位，来源标签落在数值下方
   （放在数值右侧会和数字连成串，读成「256000 上游」） */
.cc-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.cc-metric {
  padding: 14px 16px;
  border-radius: var(--lab-radius);
  border: 1px solid var(--lab-border);
  background: var(--lab-surface-2);
}
.cc-metric-label {
  font-size: 11.5px;
  letter-spacing: 0.4px;
  color: var(--lab-text-mute);
}
.cc-metric-value {
  margin-top: 6px;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--lab-text);
}
.cc-metric-sub {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--lab-text-mute);
}
.cc-src {
  margin-top: 7px;
}

.cc-owner {
  margin-top: 12px;
  font-size: 12px;
  color: var(--lab-text-sub);
}
.cc-owner code {
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--lab-surface-3);
  color: var(--lab-primary);
  font-size: 11.5px;
}
.cc-rule {
  margin-top: 7px;
  font-size: 12px;
  line-height: 1.75;
  color: var(--lab-text-mute);
}

/* 提醒列表：多条 warning 合成一张卡的列表，逐条留白 */
.cc-warn-list {
  margin: 0;
  padding-left: 18px;
}
.cc-warn-list li {
  margin-top: 6px;
  line-height: 1.75;
  font-size: 12.5px;
}
.cc-warn-list li:first-child {
  margin-top: 0;
}

/* 表格单元格：数值一行、来源标签一行 */
.cc-model-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--lab-text);
}
.cc-model-id {
  margin-top: 2px;
  font-size: 11px;
  color: var(--lab-text-mute);
}
.cc-cell-src {
  display: flex;
  gap: 5px;
  margin-top: 4px;
}
.src-tag {
  display: inline-block;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--lab-surface-3);
  color: var(--lab-text-mute);
  font-size: 10.5px;
  line-height: 16px;
}
.src-tag-warn {
  background: rgba(251, 191, 36, 0.16);
  color: var(--lab-warn);
}

/* 操作区：说明独占一行、按钮右对齐并另起一行 */
.cc-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.cc-action-hint {
  flex: 1 1 320px;
  min-width: 260px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--lab-text-sub);
}
.cc-action-btns {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.cc-open-line {
  line-height: 1.7;
  font-size: 12.5px;
}
.cc-link-btn {
  padding: 0;
  margin-top: 4px;
  height: auto;
}

/* 折叠区块：默认收起，把首屏让给结论与档位 */
.cc-adv {
  border: 1px solid var(--lab-border);
  border-radius: var(--lab-radius);
  background: var(--lab-surface);
}
.cc-adv > summary {
  padding: 11px 16px;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
  color: var(--lab-text-sub);
}
.cc-adv > summary:hover {
  color: var(--lab-primary);
}
.cc-adv[open] > summary {
  border-bottom: 1px solid var(--lab-border);
}
.cc-adv-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
}
.cc-code {
  margin: 12px;
  width: calc(100% - 24px);
  font-family: var(--lab-mono);
  font-size: 11.5px;
}
</style>
