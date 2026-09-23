<template>
  <div class="chatlab">
    <!-- 顶部标题栏 -->
    <header class="lab-head">
      <div class="lab-title">
        <h2>聊天测试台</h2>
        <p>
          走管理端登录态，不经密钥与 IP 管控 · 真实消耗积分，仅管理员可用
        </p>
      </div>
      <a-space :size="8">
        <a-button size="small" class="ghost-btn" :loading="modelsLoading" @click="loadModels">
          <template #icon><ReloadOutlined /></template>
          刷新模型
        </a-button>
        <a-button size="small" class="ghost-btn" :disabled="!messages.length" @click="clearChat">
          <template #icon><DeleteOutlined /></template>
          清空对话
        </a-button>
      </a-space>
    </header>

    <!-- 对话主体 -->
    <div class="lab-body">
      <div ref="scrollEl" class="chat-scroll">
        <!-- 空态 -->
        <div v-if="!messages.length" class="empty">
          <div class="empty-icon">
            <CommentOutlined />
          </div>
          <div class="empty-title">开始一次试调</div>
          <div class="empty-desc">
            在下方输入内容并回车即可。请求会经本管理端转发到上游，与下游调用走同一套账号池；<br>
            回答支持流式输出，每条回答的实际消耗积分会标在气泡下方。
          </div>
          <div class="empty-model">
            当前模型 <span>{{ model || '—' }}</span>
          </div>
        </div>

        <!-- 消息列表 -->
        <div
          v-for="(m, i) in messages"
          :key="i"
          class="msg"
          :class="m.role === 'user' ? 'msg-user' : 'msg-bot'"
        >
          <div class="avatar" :class="m.role === 'user' ? 'avatar-user' : 'avatar-bot'">
            <UserOutlined v-if="m.role === 'user'" />
            <RobotOutlined v-else />
          </div>

          <div class="msg-main">
            <div class="bubble" :class="m.role === 'user' ? 'bubble-user' : 'bubble-bot'">
              <!-- 思维链：默认折叠，正文才是要看的 -->
              <div v-if="m.reasoning" class="reason">
                <button class="reason-toggle" @click="m.showReasoning = !m.showReasoning">
                  <BulbOutlined />
                  思维链
                  <span class="reason-len">{{ m.reasoning.length }} 字</span>
                  <DownOutlined class="reason-arrow" :class="{ open: m.showReasoning }" />
                </button>
                <pre v-if="m.showReasoning" class="reason-text">{{ m.reasoning }}</pre>
              </div>

              <div class="bubble-text">
                <span class="whitespace-pre-wrap">{{ m.content }}</span>
                <span v-if="m.streaming" class="caret" />
                <span v-if="m.streaming && !m.content && !m.reasoning" class="thinking">
                  <span class="dot" /><span class="dot" /><span class="dot" />
                </span>
              </div>

              <div v-if="m.error" class="bubble-error">
                <ExclamationCircleOutlined />
                {{ m.error }}
              </div>
            </div>

            <!-- 元信息：实测消耗、账号、token、耗时 -->
            <div v-if="m.role === 'assistant' && !m.streaming" class="meta">
              <span class="chip chip-cost" :class="{ muted: m.cost === null || m.cost === undefined }">
                <ThunderboltOutlined />
                <template v-if="m.cost !== null && m.cost !== undefined">{{ m.cost }} 积分</template>
                <template v-else>未测到消耗</template>
              </span>
              <span v-if="m.account" class="chip">{{ m.account }}</span>
              <span v-if="m.usage" class="chip">{{ fmtNum(m.usage.total) }} Token</span>
              <span v-if="m.ms" class="chip">{{ fmtMs(m.ms) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="composer">
        <a-textarea
          v-model:value="input"
          class="composer-input"
          :auto-size="{ minRows: 2, maxRows: 6 }"
          placeholder="输入内容，Enter 发送，Shift+Enter 换行"
          :disabled="sending"
          @pressEnter="onEnter"
        />

        <div class="composer-bar">
          <div class="bar-left">
            <!-- 通道选择器：不选的话用户得手打 qwen/ 前缀才知道走哪条通道 -->
            <a-select
              v-model:value="labChannel"
              size="small"
              style="width: 122px"
              :options="channelOptions"
              @change="onChannelChange"
            />
            <a-select
              v-model:value="model"
              class="model-select"
              size="small"
              :options="modelOptions"
              show-search
              option-filter-prop="label"
            />
            <a-select v-model:value="streamMode" size="small" style="width: 104px" :options="streamOptions" />
          </div>

          <div class="bar-right">
            <span class="hint">共 {{ modelCount }} 个可用模型</span>
            <span class="hint session-cost">
              本次消耗
              <b>{{ sessionCost === null ? '—' : sessionCost }}</b>
            </span>
            <button
              class="send-btn"
              :class="{ ready: input.trim() && !sending }"
              :disabled="!input.trim() || sending"
              @click="send"
            >
              <LoadingOutlined v-if="sending" />
              <SendOutlined v-else />
            </button>
          </div>
        </div>
      </div>
    </div>

    <footer class="lab-foot">
      测试台仅用于调试（走管理端登录态，不经密钥与 IP 管控）· 正式接入请用「API 密钥」页签发的密钥<br>
      不支持的推理档位上游会自动降级
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import {
  ReloadOutlined, DeleteOutlined, UserOutlined, RobotOutlined,
  SendOutlined, LoadingOutlined, BulbOutlined, DownOutlined,
  ExclamationCircleOutlined, CommentOutlined,
} from '@ant-design/icons-vue'
import client from '@/api/client'
import { channelStore, CHANNELS } from '@/stores/channel'
import { qwenworkApi as qwenApi } from '@/api/qwenwork'
import type { ChatLabModels } from '@/api/chatlab'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  showReasoning?: boolean
  streaming?: boolean
  error?: string
  cost?: number | null
  account?: string
  usage?: { input: number; output: number; total: number }
  ms?: number
}

const models = ref<ChatLabModels | null>(null)
const modelsLoading = ref(false)
const model = ref('')
const input = ref('')
const sending = ref(false)
const streamMode = ref('stream')
const messages = ref<ChatMessage[]>([])
const sessionCost = ref<number | null>(null)
const scrollEl = ref<HTMLElement | null>(null)

const streamOptions = [
  { label: '流式输出', value: 'stream' },
  { label: '非流式', value: 'plain' },
]

// 通道选择：测试台原本只能靠手打 `qwen/` 前缀走千问，这里给个下拉。
// 选项与全局切换器同源（stores/channel），避免两处各维护一份通道表。
const labChannel = ref(channelStore.current)
const channelOptions = CHANNELS.map((c) => ({ label: c.label, value: c.id }))

// 千问模型：从管理端接口拿（含中文名），选中的值带上 `qwen/` 前缀
const qwModels = ref<Array<{ id: string; name: string; prefixed: string }>>([])
async function onChannelChange(id: string) {
  model.value = ''
  if (id === 'qwenwork' && !qwModels.value.length) {
    try {
      const { data } = await qwenApi.models()
      qwModels.value = data.models || []
    } catch { /* 拿不到就空列表，不阻断 */ }
  }
}

// 上游模型与别名都列出来：别名能不能用恰恰是要试的东西
const modelOptions = computed(() => {
  const out: Array<{ label: string; value: string }> = []
  if (labChannel.value === 'qwenwork') {
    for (const m of qwModels.value) {
      // value 带前缀：网关靠前缀分流，不带就跑到搭子上去了
      out.push({ label: `${m.name} (${m.prefixed})`, value: m.prefixed })
    }
    return out
  }
  for (const m of models.value?.exposed ?? []) {
    out.push({ label: `${m.id}（上游）`, value: m.id })
  }
  for (const m of models.value?.aliases ?? []) {
    out.push({ label: `${m.id} → ${m.mapped}`, value: m.id })
  }
  return out
})
const modelCount = computed(() => modelOptions.value.length)

const fmtNum = (n: number) => (n || 0).toLocaleString('zh-CN')
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`)

async function loadModels() {
  modelsLoading.value = true
  try {
    const { data } = await client.get('/chatlab/models')
    models.value = data
    if (!model.value) model.value = data.exposed?.[0]?.id || data.aliases?.[0]?.id || ''
  } finally {
    modelsLoading.value = false
  }
}

async function loadSessionCost() {
  try {
    const { data } = await client.get('/chatlab/session-cost')
    sessionCost.value = data.consumed ?? null
  } catch (e) { /* 拿不到就显示 — */ }
}

function onEnter(e: KeyboardEvent) {
  // Shift+Enter 换行，单独 Enter 发送
  if (e.shiftKey) return
  e.preventDefault()
  send()
}

function clearChat() {
  messages.value = []
  // 基准重置：否则「本次消耗」会把清空前的那部分也算进来
  client.post('/chatlab/session-cost/reset').then(() => loadSessionCost()).catch(() => {})
}

async function scrollToBottom() {
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return
  input.value = ''
  messages.value.push({ role: 'user', content: text })
  messages.value.push({
    role: 'assistant', content: '', reasoning: '', streaming: true, showReasoning: false,
  })
  const target = messages.value[messages.value.length - 1]
  sending.value = true
  await scrollToBottom()

  const history = messages.value
    .filter((m) => m.content && !m.streaming)
    .map((m) => ({ role: m.role, content: m.content }))

  try {
    if (streamMode.value === 'plain') {
      const { data } = await client.post('/chatlab/chat', {
        model: model.value, messages: history, stream: false,
      })
      target.content = data.content || '(空回答)'
      target.reasoning = data.reasoning || ''
      target.account = data.account
      target.usage = data.usage
      target.cost = data.cost
      target.ms = data.ms
      target.streaming = false
      await loadSessionCost()
      return
    }

    // 流式：用 fetch 读 SSE（axios 不方便逐块读）
    const resp = await fetch('/api/admin/chatlab/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ model: model.value, messages: history, stream: true }),
    })
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}))
      throw new Error(j.error || `HTTP ${resp.status}`)
    }
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() || ''
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let evt: any
        try { evt = JSON.parse(line.slice(5).trim()) } catch (e) { continue }
        if (evt.type === 'delta') { target.content += evt.text; await scrollToBottom() }
        else if (evt.type === 'reasoning') { target.reasoning = (target.reasoning || '') + evt.text }
        else if (evt.type === 'meta') { target.account = evt.account }
        else if (evt.type === 'usage') { target.usage = evt.usage }
        else if (evt.type === 'error') { target.error = evt.error }
        else if (evt.type === 'done') {
          target.usage = evt.usage
          target.account = evt.account || target.account
          target.cost = evt.cost
        }
      }
    }
    target.streaming = false
    if (!target.content) target.content = target.error ? '' : '(空回答)'
    await loadSessionCost()
  } catch (e: any) {
    target.error = e?.message || '请求失败'
    target.streaming = false
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

onMounted(() => {
  loadModels()
  loadSessionCost()
})
</script>

<style scoped>
/* 整页铺满内容区：对话要占满高度，输入框贴底 */
.chatlab {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 96px);
  gap: 12px;
}

/* ---------- 顶部 ---------- */
.lab-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.lab-title h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--lab-text);
  letter-spacing: 0.2px;
}
.lab-title p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--lab-text-mute);
}

/* ---------- 主体 ---------- */
.lab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--lab-surface);
  border: 1px solid var(--lab-border);
  border-radius: 14px;
  box-shadow: var(--lab-shadow);
  overflow: hidden;
}

.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 24px 8px;
  scroll-behavior: smooth;
}
.chat-scroll::-webkit-scrollbar {
  width: 8px;
}
.chat-scroll::-webkit-scrollbar-thumb {
  background: #26313f;
  border-radius: 4px;
}
.chat-scroll::-webkit-scrollbar-thumb:hover {
  background: #33404f;
}

/* ---------- 空态 ---------- */
.empty {
  height: 100%;
  min-height: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 16px;
}
.empty-icon {
  width: 52px;
  height: 52px;
  border-radius: 16px;
  background: var(--lab-primary-dim);
  color: var(--lab-primary);
  font-size: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}
.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--lab-text);
  margin-bottom: 8px;
}
.empty-desc {
  font-size: 12px;
  color: var(--lab-text-mute);
  line-height: 1.9;
}
.empty-model {
  margin-top: 16px;
  font-size: 12px;
  color: var(--lab-text-mute);
}
.empty-model span {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--lab-surface-3);
  color: var(--lab-text-sub);
  font-family: var(--lab-mono);
}

/* ---------- 消息 ---------- */
.msg {
  display: flex;
  gap: 10px;
  margin-bottom: 22px;
  align-items: flex-start;
}
.msg-user {
  flex-direction: row-reverse;
}
.msg-main {
  min-width: 0;
  max-width: 78%;
  display: flex;
  flex-direction: column;
}
.msg-user .msg-main {
  align-items: flex-end;
}

.avatar {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  margin-top: 2px;
}
.avatar-user {
  background: linear-gradient(135deg, #22d3ee, #0ea5b7);
  color: #04222a;
}
.avatar-bot {
  background: var(--lab-surface-3);
  color: var(--lab-text-sub);
}

.bubble {
  padding: 11px 15px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.75;
  word-break: break-word;
}
.bubble-user {
  background: linear-gradient(135deg, #0e7490, #155e75);
  color: #e8faff;
  border-top-right-radius: 4px;
  box-shadow: 0 2px 10px rgba(14, 116, 144, 0.35);
}
.bubble-bot {
  background: var(--lab-surface-2);
  color: var(--lab-text);
  border: 1px solid var(--lab-border);
  border-top-left-radius: 4px;
}
.bubble-error {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(248, 113, 113, 0.4);
  font-size: 12px;
  color: var(--lab-danger);
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 思维链 */
.reason {
  margin-bottom: 10px;
}
.reason-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--lab-border-strong);
  background: var(--lab-surface-2);
  border-radius: 999px;
  font-size: 12px;
  color: var(--lab-text-sub);
  cursor: pointer;
  transition: all 0.15s;
}
.reason-toggle:hover {
  border-color: var(--lab-primary-line);
  color: var(--lab-primary);
}
.reason-len {
  color: var(--lab-text-mute);
}
.reason-arrow {
  font-size: 10px;
  transition: transform 0.2s;
}
.reason-arrow.open {
  transform: rotate(180deg);
}
.reason-text {
  margin: 8px 0 0;
  padding: 10px 12px;
  background: var(--lab-bg-2);
  border: 1px solid var(--lab-border);
  border-left: 3px solid var(--lab-primary-line);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--lab-text-sub);
  white-space: pre-wrap;
  max-height: 220px;
  overflow-y: auto;
  font-family: var(--lab-mono);
}

/* 流式光标与等待点 */
.caret {
  display: inline-block;
  width: 2px;
  height: 15px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--lab-primary);
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
.thinking {
  display: inline-flex;
  gap: 4px;
  margin-left: 4px;
}
.thinking .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--lab-text-mute);
  animation: bounce 1.2s infinite ease-in-out;
}
.thinking .dot:nth-child(2) { animation-delay: 0.15s; }
.thinking .dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* 元信息芯片 */
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--lab-surface-2);
  border: 1px solid var(--lab-border);
  font-size: 11px;
  color: var(--lab-text-mute);
}
.chip-cost {
  background: rgba(52, 211, 153, 0.12);
  border-color: rgba(52, 211, 153, 0.3);
  color: var(--lab-ok);
  font-weight: 500;
}
.chip-cost.muted {
  background: var(--lab-surface-2);
  border-color: var(--lab-border);
  color: var(--lab-text-mute);
  font-weight: 400;
}

/* ---------- 输入区 ---------- */
.composer {
  flex: none;
  border-top: 1px solid var(--lab-border);
  padding: 12px 16px 14px;
  background: var(--lab-bg-2);
}
.composer-input {
  border-radius: 10px !important;
  border-color: var(--lab-border-strong) !important;
  font-size: 14px;
  resize: none;
}
.composer-input:hover {
  border-color: #33404f !important;
}
.composer-input:focus,
.composer-input:focus-within {
  border-color: var(--lab-primary-line) !important;
  box-shadow: 0 0 0 3px var(--lab-primary-dim) !important;
}
.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.bar-left,
.bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-select {
  min-width: 230px;
}
.hint {
  font-size: 11px;
  color: var(--lab-text-mute);
}
.session-cost b {
  color: var(--lab-text-sub);
  font-weight: 600;
}
.send-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: var(--lab-surface-3);
  color: var(--lab-text-mute);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: not-allowed;
  transition: all 0.18s;
  font-size: 14px;
}
.send-btn.ready {
  background: linear-gradient(135deg, #22d3ee, #0ea5b7);
  color: #04222a;
  cursor: pointer;
  box-shadow: 0 3px 12px rgba(34, 211, 238, 0.32);
}
.send-btn.ready:hover {
  transform: translateY(-1px);
  box-shadow: 0 5px 16px rgba(34, 211, 238, 0.42);
}

/* ---------- 页脚 ---------- */
.lab-foot {
  flex: none;
  text-align: center;
  font-size: 11px;
  color: var(--lab-text-mute);
  line-height: 1.8;
}
</style>
