<template>
  <div>
    <a-row :gutter="[16, 16]">
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="代理网关" :value="status ? '在线' : '—'">
            <template #suffix>
              <a-badge v-if="status" :status="status.gateway.online ? 'success' : 'error'" />
            </template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            端口 {{ status?.gateway.port ?? '—' }}
          </div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="上游端口" :value="status?.upstream.port ?? '—'" />
          <div class="text-xs text-slate-500 mt-2">
            来源 {{ status?.gateway.source ?? '—' }}
          </div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic
            title="后端进程"
            :value="status?.upstream.managed ? '自建' : '外部'"
          />
          <div class="text-xs text-slate-500 mt-2">
            固定端口 {{ status?.upstream.managed_port ?? '—' }}
          </div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="登录账号" :value="status?.account?.name ?? '未登录'" />
          <div class="text-xs text-slate-500 mt-2">DuMate 登录态</div>
        </a-card>
      </a-col>
    </a-row>

    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="12">
        <a-card title="端口发现链路" :bordered="false">
          <a-empty
            v-if="!status?.upstream.discovery.length"
            description="未通过命令行或监听套接字发现，走了已知端口或自建拉起"
          />
          <a-steps
            v-else
            direction="vertical"
            size="small"
            :current="status.upstream.discovery.findIndex((s) => s.hit)"
          >
            <a-step
              v-for="(step, i) in status.upstream.discovery"
              :key="i"
              :title="step.method"
              :description="`端口 ${step.port}`"
              :status="step.hit ? 'finish' : 'wait'"
            />
          </a-steps>
        </a-card>
      </a-col>
      <a-col :span="12">
        <a-card title="安装与运行时" :bordered="false">
          <a-descriptions :column="1" size="small" bordered>
            <a-descriptions-item label="安装目录">
              <span class="break-all">{{ status?.install.dir }}</span>
            </a-descriptions-item>
            <a-descriptions-item label="后端可执行文件">
              <a-tag :color="status?.install.exe_exists ? 'green' : 'red'">
                {{ status?.install.exe_exists ? '存在' : '缺失' }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="配置文件">
              <a-tag :color="status?.install.config_exists ? 'green' : 'red'">
                {{ status?.install.config_exists ? '存在' : '缺失' }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="Node 版本">
              {{ status?.versions.node }}
            </a-descriptions-item>
            <a-descriptions-item label="管理进程">
              PID {{ status?.admin.pid }} / 端口 {{ status?.admin.port }}
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>
    </a-row>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import client from '@/api/client'
import type { SystemStatus } from '@/api/system'

const status = ref<SystemStatus | null>(null)

onMounted(async () => {
  const { data } = await client.get('/system/status')
  status.value = data
})
</script>
