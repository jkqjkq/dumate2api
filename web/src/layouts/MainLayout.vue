<template>
  <a-layout class="min-h-screen">
    <a-layout-sider v-model:collapsed="collapsed" collapsible :width="208">
      <div class="h-14 flex items-center justify-center text-white font-semibold tracking-wide">
        <span v-if="!collapsed">DuMate 管理</span>
        <span v-else>DM</span>
      </div>
      <a-menu theme="dark" mode="inline" :selected-keys="selectedKeys" @click="onMenu">
        <a-menu-item key="dashboard">
          <template #icon><DashboardOutlined /></template>
          <span>仪表盘</span>
        </a-menu-item>
        <a-menu-item key="models">
          <template #icon><DeploymentUnitOutlined /></template>
          <span>模型管理</span>
        </a-menu-item>
        <a-menu-item key="keys">
          <template #icon><KeyOutlined /></template>
          <span>API Key</span>
        </a-menu-item>
      </a-menu>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="flex items-center justify-between px-6 bg-white">
        <span class="text-base font-medium">管理系统</span>
        <a-space>
          <a-tag color="blue">{{ auth.user?.username }}</a-tag>
          <a-button size="small" @click="onLogout">退出</a-button>
        </a-space>
      </a-layout-header>
      <a-layout-content class="m-4">
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DashboardOutlined, DeploymentUnitOutlined, KeyOutlined } from '@ant-design/icons-vue'
import { auth } from '@/stores/auth'

const collapsed = ref(false)
const router = useRouter()
const route = useRoute()

// 选中态跟着路由走，否则点进模型管理后侧边栏仍高亮仪表盘
const selectedKeys = computed(() => [String(route.meta.key || 'dashboard')])

function onMenu({ key }: { key: string }) {
  router.push(key === 'dashboard' ? '/' : `/${key}`)
}

async function onLogout() {
  await auth.logout()
  router.push('/login')
}
</script>
