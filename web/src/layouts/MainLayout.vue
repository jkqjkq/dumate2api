<template>
  <a-layout class="min-h-screen lab-shell">
    <a-layout-sider v-model:collapsed="collapsed" collapsible :width="216" class="lab-sider">
      <div class="lab-logo">
        <span class="logo-mark">DM</span>
        <span v-if="!collapsed" class="logo-text">DuMate<span class="logo-accent">控制台</span></span>
      </div>
      <a-menu theme="dark" mode="inline" :selected-keys="selectedKeys" @click="onMenu">
        <a-menu-item key="dashboard">
          <template #icon><DashboardOutlined /></template>
          <span>仪表盘</span>
        </a-menu-item>
        <a-menu-item key="chatlab">
          <template #icon><CommentOutlined /></template>
          <span>聊天测试台</span>
        </a-menu-item>
        <a-menu-item key="usage">
          <template #icon><BarChartOutlined /></template>
          <span>用量统计</span>
        </a-menu-item>
        <a-menu-item key="reqlogs">
          <template #icon><FileTextOutlined /></template>
          <span>请求日志</span>
        </a-menu-item>
        <a-menu-item key="models">
          <template #icon><DeploymentUnitOutlined /></template>
          <span>模型管理</span>
        </a-menu-item>
        <a-menu-item key="keys">
          <template #icon><KeyOutlined /></template>
          <span>API Key</span>
        </a-menu-item>
        <a-menu-item key="account">
          <template #icon><UserOutlined /></template>
          <span>登录态</span>
        </a-menu-item>
        <a-menu-item key="points">
          <template #icon><WalletOutlined /></template>
          <span>积分明细</span>
        </a-menu-item>
        <a-menu-item key="web-accounts">
          <template #icon><TeamOutlined /></template>
          <span>账号管理</span>
        </a-menu-item>
        <a-menu-item key="records">
          <template #icon><HistoryOutlined /></template>
          <span>任务记录</span>
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
        <div class="lab-crumb">
          <span class="crumb-root">控制台</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-cur">{{ currentTitle }}</span>
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
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DashboardOutlined, DeploymentUnitOutlined, KeyOutlined, UserOutlined, WalletOutlined, TeamOutlined, HistoryOutlined, BarChartOutlined, FileTextOutlined, CommentOutlined } from '@ant-design/icons-vue'
import { auth } from '@/stores/auth'

const collapsed = ref(false)
const router = useRouter()
const route = useRoute()

// 选中态跟着路由走，否则点进模型管理后侧边栏仍高亮仪表盘
const selectedKeys = computed(() => [String(route.meta.key || 'dashboard')])
// 面包屑当前段：取自路由 meta，避免顶栏与页内标题各写一份文案
const currentTitle = computed(() => String(route.meta.title || '仪表盘'))

function onMenu({ key }: { key: string }) {
  router.push(key === 'dashboard' ? '/' : `/${key}`)
}

async function onLogout() {
  await auth.logout()
  router.push('/login')
}
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
