<template>
  <a-layout class="min-h-screen lab-shell">
    <a-layout-sider v-model:collapsed="collapsed" collapsible :width="216" class="lab-sider">
      <div class="lab-logo">
        <span class="logo-mark">DM</span>
        <span v-if="!collapsed" class="logo-text">DuMate<span class="logo-accent">控制台</span></span>
      </div>
      <a-menu theme="dark" mode="inline" :selected-keys="selectedKeys" @click="onMenu">
        <a-menu-item v-if="showMenu('dashboard')" key="dashboard">
          <template #icon><DashboardOutlined /></template>
          <span>仪表盘</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('chatlab')" key="chatlab">
          <template #icon><CommentOutlined /></template>
          <span>聊天测试台</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('usage')" key="usage">
          <template #icon><BarChartOutlined /></template>
          <span>用量统计</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('reqlogs')" key="reqlogs">
          <template #icon><FileTextOutlined /></template>
          <span>请求日志</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('models')" key="models">
          <template #icon><DeploymentUnitOutlined /></template>
          <span>模型管理</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('keys')" key="keys">
          <template #icon><KeyOutlined /></template>
          <span>API Key</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('account')" key="account">
          <template #icon><UserOutlined /></template>
          <span>登录态</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('points')" key="points">
          <template #icon><WalletOutlined /></template>
          <span>积分明细</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('web-accounts')" key="web-accounts">
          <template #icon><TeamOutlined /></template>
          <span>账号管理</span>
        </a-menu-item>
      </a-menu>
      <div v-if="!collapsed" class="lab-sider-foot">
        <span class="dot" />
        <span>网关控制台 · v1.1</span>
      </div>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="lab-header">
        <!-- 顶栏放面包屑而不是重复页名：页内已有大标题（PageHeader），
             两处都写会并排出现两个同名标题；写成「控制台 / 页面」则读作
             导航位置，同时补上侧边栏折叠后丢失的上下文 -->
        <div class="lab-left">
          <!-- 通道切换器放顶栏而不是侧栏：侧栏可折叠，折叠后它会消失，
               而「当前在看哪个通道」是全局上下文，任何时候都不该丢。
               顶栏是 sticky 的，滚动时始终可见。 -->
          <div class="ch-switch">
            <button
              v-for="c in CHANNELS"
              :key="c.id"
              class="ch-btn"
              :class="{ on: channelStore.current === c.id }"
              :title="titleFor(c.id)"
              @click="onChannel(c.id)"
            >
              <span class="ch-dot" :class="dotClass(c.id)" />
              {{ c.label }}
            </button>
          </div>
          <div class="lab-crumb">
            <span class="crumb-root">控制台</span>
            <span class="crumb-sep">/</span>
            <span class="crumb-cur">{{ currentTitle }}</span>
          </div>
        </div>
        <a-space :size="10">
          <a-tag class="user-tag">{{ auth.user?.username }}</a-tag>
          <a-button size="small" class="ghost-btn" @click="onLogout">退出</a-button>
        </a-space>
      </a-layout-header>
      <a-layout-content class="lab-content">
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DashboardOutlined, DeploymentUnitOutlined, KeyOutlined, UserOutlined, WalletOutlined, TeamOutlined, BarChartOutlined, FileTextOutlined, CommentOutlined } from '@ant-design/icons-vue'
import { auth } from '@/stores/auth'
import { channelStore, CHANNELS } from '@/stores/channel'

const collapsed = ref(false)
const router = useRouter()
const route = useRoute()

// 选中态跟着路由走，否则点进模型管理后侧边栏仍高亮仪表盘
const selectedKeys = computed(() => [String(route.meta.key || 'dashboard')])
// 面包屑当前段：取自路由 meta，避免顶栏与页内标题各写一份文案
const currentTitle = computed(() => String(route.meta.title || '仪表盘'))

// 菜单按通道过滤：搭子有账号池/积分/密钥，千问没有——与其让用户点进去
// 看到一片空，不如直接隐藏。白名单定义在 stores/channel.ts。
function showMenu(key: string): boolean {
  return (channelStore.menuKeys() as readonly string[]).includes(key)
}

// 切通道时若当前页在新通道里不存在，回仪表盘——否则会停在一个
// 已被隐藏的页面（菜单里没有入口，用户退不出去）。
function onChannel(id: string) {
  channelStore.set(id)
  const key = String(route.meta.key || 'dashboard')
  if (!showMenu(key)) router.push('/')
}

function titleFor(id: string): string {
  const i = channelStore.infos[id]
  if (!i) return ''
  if (!i.ready) return i.error || '不可用'
  if (i.kind === 'direct') {
    // 千问有 wasm 依赖；Qoder/TRAE 没有（Qoder 签名纯本地）。
    // 对没有 wasm 的通道显示「wasm 未知」是凭空报一个不存在的故障。
    const bits = ['直连']
    if (i.wasm) bits.push(`wasm ${i.wasm}`)
    if (i.accounts != null && i.accounts > 0) bits.push(`${i.accounts} 个账号`)
    if (i.account) bits.push(i.account)
    if (i.refreshExpired) bits.push('refresh token 已过期，需重新登录')
    return bits.join(' · ')
  }
  return `端口 ${i.port || '—'}` + (i.managed ? ' · 自托管' : '')
}

// 状态点：绿=就绪，黄=就绪但登录态将失效，红=不可用，灰=未知
function dotClass(id: string): string {
  const i = channelStore.infos[id]
  if (!i) return 'unknown'
  if (!i.ready) return 'bad'
  if (i.refreshExpired) return 'warn'
  return 'ok'
}

function onMenu({ key }: { key: string }) {
  router.push(key === 'dashboard' ? '/' : `/${key}`)
}

async function onLogout() {
  await auth.logout()
  router.push('/login')
}

// 拉一次通道状态给顶栏徽标用。失败不阻断——只是徽标不显示颜色。
onMounted(() => { channelStore.load() })
</script>

<style scoped>
.lab-shell {
  background: transparent;
}

/* 侧栏：比内容区再暗一档，靠明度分层而不是靠边框 */
.lab-sider {
  background: #080b11 !important;
  border-right: 1px solid var(--lab-border);
}
.lab-sider :deep(.ant-layout-sider-trigger) {
  background: #0b0f16;
  border-top: 1px solid var(--lab-border);
  color: var(--lab-text-mute);
}
.lab-logo {
  height: 60px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
  border-bottom: 1px solid var(--lab-border);
}
.logo-mark {
  width: 30px;
  height: 30px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: linear-gradient(135deg, #22d3ee, #0ea5b7);
  color: #04222a;
  font-family: var(--lab-mono);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.5px;
  box-shadow: 0 0 18px rgba(34, 211, 238, 0.34);
}
.logo-text {
  font-family: var(--lab-display);
  color: var(--lab-text);
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.6px;
  white-space: nowrap;
}
.logo-accent {
  color: var(--lab-primary);
  margin-left: 3px;
}
.lab-sider :deep(.ant-menu) {
  background: transparent;
  border-inline-end: none !important;
  padding: 10px 10px 0;
}
.lab-sider :deep(.ant-menu-item) {
  border-radius: 9px;
  margin: 2px 0;
  height: 40px;
  line-height: 40px;
  font-size: 13px;
  position: relative;
}
.lab-sider :deep(.ant-menu-item-selected) {
  background: var(--lab-primary-dim) !important;
  color: var(--lab-primary) !important;
  font-weight: 600;
}
/* 选中态左侧的信号条：比整行高亮更克制，也和「控制台」的语义一致 */
.lab-sider :deep(.ant-menu-item-selected)::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 0 3px 3px 0;
  background: var(--lab-primary);
  box-shadow: 0 0 10px rgba(34, 211, 238, 0.7);
}
.lab-sider :deep(.ant-menu-item-selected .anticon) {
  color: var(--lab-primary);
}
.lab-sider-foot {
  position: absolute;
  bottom: 52px;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 20px;
  font-size: 11px;
  color: var(--lab-text-mute);
  letter-spacing: 0.3px;
}
.lab-sider-foot .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--lab-ok);
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.8);
}

/* 顶栏左区：切换器 + 面包屑 */
.lab-left {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
}
.ch-switch {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border-radius: 10px;
  background: var(--lab-surface-2);
  border: 1px solid var(--lab-border);
}
.ch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--lab-text-sub);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.16s ease;
  white-space: nowrap;
}
.ch-btn:hover {
  color: var(--lab-text);
  background: rgba(255, 255, 255, 0.04);
}
.ch-btn.on {
  background: var(--lab-primary-dim);
  color: var(--lab-primary);
  font-weight: 600;
}
.ch-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.ch-dot.ok {
  background: var(--lab-ok);
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.8);
}
.ch-dot.warn {
  background: var(--lab-warn);
  box-shadow: 0 0 8px rgba(251, 191, 36, 0.8);
}
.ch-dot.bad {
  background: var(--lab-danger);
  box-shadow: 0 0 8px rgba(248, 113, 113, 0.8);
}
.ch-dot.unknown {
  background: var(--lab-text-mute);
}

/* 顶栏：半透明 + 毛玻璃，滚动时内容从下面透出来 */
.lab-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  height: 58px;
  line-height: 58px;
  background: rgba(13, 18, 25, 0.82);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--lab-border);
  position: sticky;
  top: 0;
  z-index: 10;
}
.lab-crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.crumb-root {
  color: var(--lab-text-mute);
}
.crumb-sep {
  color: #33404f;
}
.crumb-cur {
  color: var(--lab-text);
  font-weight: 600;
  font-family: var(--lab-display);
  letter-spacing: 0.3px;
}
.user-tag {
  border-radius: 999px;
  padding: 2px 12px;
  background: var(--lab-primary-dim);
  border-color: var(--lab-primary-line);
  color: var(--lab-primary);
  font-family: var(--lab-mono);
  font-size: 11.5px;
}

/* 内容区：给页面留一致的呼吸空间 */
.lab-content {
  margin: 20px;
}
</style>
