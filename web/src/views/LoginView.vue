<template>
  <div class="min-h-screen flex items-center justify-center bg-slate-100">
    <a-card class="w-[380px]" :bordered="false">
      <div class="text-center mb-6">
        <h1 class="text-xl font-semibold m-0">DuMate 管理系统</h1>
        <p class="text-slate-500 text-sm mt-2">登录后可管理代理与上游状态</p>
      </div>
      <a-form layout="vertical" @finish="onSubmit">
        <a-form-item label="用户名">
          <a-input v-model:value="form.username" size="large" placeholder="admin" />
        </a-form-item>
        <a-form-item label="密码">
          <a-input-password v-model:value="form.password" size="large" placeholder="初始密码见启动日志" />
        </a-form-item>
        <a-alert v-if="error" :message="error" type="error" show-icon class="mb-4" />
        <a-button type="primary" html-type="submit" size="large" block :loading="loading">
          登录
        </a-button>
      </a-form>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { auth } from '@/stores/auth'

const router = useRouter()
const form = reactive({ username: 'admin', password: '' })
const loading = ref(false)
const error = ref('')

async function onSubmit() {
  loading.value = true
  error.value = ''
  try {
    await auth.login(form.username, form.password)
    router.push('/')
  } catch (e: any) {
    const status = e?.response?.status
    if (status === 429) {
      const secs = e?.response?.data?.retry_after ?? 0
      error.value = `尝试次数过多，请 ${Math.ceil(secs / 60)} 分钟后再试`
    } else {
      error.value = '用户名或密码错误'
    }
  } finally {
    loading.value = false
  }
}
</script>
