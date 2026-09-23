<template>
  <div class="login-wrap">
    <!-- 背景：网格 + 青色辉光，与内容区同源，登录页也读作「同一个控制台」 -->
    <div class="grid-layer" />
    <div class="glow glow-1" />
    <div class="glow glow-2" />

    <div class="login-card">
      <div class="brand">
        <div class="brand-mark">DM</div>
        <div class="brand-titles">
          <h1>DuMate <span class="accent">控制台</span></h1>
          <p>模型网关 · 账号池 · 用量监控</p>
        </div>
      </div>

      <div class="divider" />

      <a-form layout="vertical" @finish="onSubmit">
        <a-form-item label="用户名">
          <a-input v-model:value="form.username" size="large" placeholder="admin">
            <template #prefix><UserOutlined class="input-icon" /></template>
          </a-input>
        </a-form-item>
        <a-form-item label="密码">
          <a-input-password
            v-model:value="form.password"
            size="large"
            placeholder="初始密码见启动日志"
          >
            <template #prefix><LockOutlined class="input-icon" /></template>
          </a-input-password>
        </a-form-item>
        <a-alert v-if="error" :message="error" type="error" show-icon class="mb-4" />
        <a-button
          type="primary"
          html-type="submit"
          size="large"
          block
          :loading="loading"
          class="login-btn"
          @click="onSubmit"
        >
          登录
        </a-button>
      </a-form>

      <p class="foot">仅限本机访问 · 会话由 admin.secret 签名</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { UserOutlined, LockOutlined } from '@ant-design/icons-vue'
import { auth } from '@/stores/auth'

const router = useRouter()
const form = reactive({ username: 'admin', password: '' })
const loading = ref(false)
const error = ref('')

async function onSubmit() {
  // 按钮 click 与表单 finish 两条路都会进这里，重复提交会白白消耗一次
  // 失败计数（5 次就锁定）
  if (loading.value) return
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

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lab-bg);
  position: relative;
  overflow: hidden;
}
.grid-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.022) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.022) 1px, transparent 1px);
  background-size: 46px 46px;
  mask-image: radial-gradient(circle at 50% 42%, #000 0%, transparent 72%);
}
.glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.5;
  pointer-events: none;
}
.glow-1 {
  width: 460px;
  height: 460px;
  background: #0e7490;
  top: -140px;
  left: -100px;
}
.glow-2 {
  width: 380px;
  height: 380px;
  background: #0b3b4a;
  bottom: -160px;
  right: -80px;
}

.login-card {
  position: relative;
  z-index: 1;
  width: 404px;
  padding: 34px 34px 26px;
  background: rgba(18, 24, 36, 0.9);
  backdrop-filter: blur(16px);
  border: 1px solid var(--lab-border-strong);
  border-radius: 18px;
  box-shadow: 0 30px 70px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(34, 211, 238, 0.05);
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}
.brand-mark {
  width: 46px;
  height: 46px;
  flex: none;
  border-radius: 13px;
  background: linear-gradient(135deg, #22d3ee, #0ea5b7);
  color: #04222a;
  font-family: var(--lab-mono);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 26px rgba(34, 211, 238, 0.4);
}
.brand-titles h1 {
  margin: 0;
  font-family: var(--lab-display);
  font-size: 19px;
  font-weight: 600;
  color: var(--lab-text);
  letter-spacing: 0.5px;
}
.brand-titles .accent {
  color: var(--lab-primary);
}
.brand-titles p {
  margin: 5px 0 0;
  font-size: 12px;
  color: var(--lab-text-mute);
  letter-spacing: 0.3px;
}
.divider {
  height: 1px;
  margin: 22px 0 20px;
  background: linear-gradient(90deg, transparent, var(--lab-border-strong) 22%, var(--lab-border-strong) 78%, transparent);
}

.input-icon {
  color: var(--lab-text-mute);
}
.login-btn {
  height: 44px;
  border-radius: 11px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 2px;
  margin-top: 4px;
}
.foot {
  margin: 20px 0 0;
  text-align: center;
  font-size: 11px;
  color: var(--lab-text-mute);
  letter-spacing: 0.3px;
}
</style>
