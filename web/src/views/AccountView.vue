<template>
  <div>
    <a-alert type="info" show-icon class="mb-4" :message="data?.readonly_note || '只读页面'">
      <template #description>
        本页只展示客户端当前状态。修改登录态请使用 DuMate 客户端本身，
        管理端不做写入，以免两侧状态不一致。
      </template>
    </a-alert>

    <a-row :gutter="[16, 16]">
      <a-col :span="8">
        <a-card :bordered="false">
          <a-statistic title="客户端版本" :value="data?.version?.file_version || '未知'" />
          <div class="text-xs text-slate-500 mt-2">
            {{ data?.version?.company || '—' }}
            <template v-if="data?.version?.product_version">
              · {{ data.version.product_version }}
            </template>
          </div>
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card :bordered="false">
          <a-statistic title="登录账号" :value="activeAccount?.name || '未登录'" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="activeAccount">
              {{ activeAccount.age_days }} 天前登录 · {{ activeAccount.login_type || '—' }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card :bordered="false">
          <a-statistic
            title="后端进程"
            :value="data?.processes.length ? '运行中' : '未运行'"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="data?.processes.length">
              <span v-for="p in data.processes" :key="p.pid" class="block">
                {{ p.name }} #{{ p.pid }} · 端口 {{ p.port ?? '—' }}
              </span>
            </template>
            <span v-else>没有发现 dumate 进程</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="12">
        <a-card title="登录态" :bordered="false">
          <a-empty v-if="!data?.login.ok" :description="data?.login.reason || '读取失败'" />
          <template v-else>
            <a-descriptions :column="1" size="small" bordered>
              <a-descriptions-item label="登录态文件">
                <span class="break-all text-xs">{{ data.login.file }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="文件大小">
                {{ data.login.file_stat?.size ?? '—' }} 字节
              </a-descriptions-item>
              <a-descriptions-item label="最后更新">
                {{ data.login.file_stat ? dateText(data.login.file_stat.mtime) : '—' }}
              </a-descriptions-item>
              <a-descriptions-item label="当前凭证">
                <a-tag :color="data.login.has_top_level_cookies ? 'green' : 'red'">
                  {{ data.login.has_top_level_cookies ? '存在' : '缺失' }}
                </a-tag>
                <span class="text-xs text-slate-500 ml-1">（顶层 cookies）</span>
              </a-descriptions-item>
              <a-descriptions-item label="凭证密钥文件">
                <a-tag :color="data.login.cookie_key_present ? 'green' : 'red'">
                  {{ data.login.cookie_key_present ? '存在' : '缺失' }}
                </a-tag>
                <span class="text-xs text-slate-500 ml-1">（.cookie-key）</span>
              </a-descriptions-item>
              <a-descriptions-item label="登录提供方">
                {{ data.login.active_provider || '—' }}
              </a-descriptions-item>
            </a-descriptions>
          </template>
        </a-card>
      </a-col>

      <a-col :span="12">
        <a-card title="账号列表" :bordered="false">
          <a-empty v-if="!data?.login.accounts?.length" description="没有已登录的账号" />
          <a-table
            v-else
            size="small"
            :pagination="false"
            :data-source="data.login.accounts"
            :columns="accountColumns"
            row-key="user_id"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <div>{{ record.name }}</div>
                <div class="text-xs text-slate-400 font-mono">
                  {{ (record.user_id || '').slice(0, 12) }}…
                </div>
              </template>
              <template v-else-if="column.key === 'state'">
                <a-tag :color="record.state === 'active' ? 'green' : 'orange'">
                  {{ record.state === 'active' ? '有效' : '失效' }}
                </a-tag>
                <a-tag v-if="record.active" color="blue">当前</a-tag>
              </template>
              <template v-else-if="column.key === 'last'">
                {{ record.last_login ? dateText(record.last_login) : '—' }}
                <span v-if="record.age_days !== null" class="text-xs text-slate-400 ml-1">
                  ({{ record.age_days }} 天前)
                </span>
              </template>
              <template v-else-if="column.key === 'cred'">
                <a-tag :color="record.has_credentials ? 'green' : 'red'">
                  {{ record.has_credentials ? '有' : '无' }}
                </a-tag>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            上游不提供登录态过期时间，此处按凭证存在性与最后登录时间推断
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-card title="安装完整性" :bordered="false" class="mt-4">
      <a-table
        size="small"
        :pagination="false"
        :data-source="data?.install.checks ?? []"
        :columns="checkColumns"
        row-key="key"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'exists'">
            <a-tag :color="record.exists ? 'green' : 'red'">
              {{ record.exists ? '存在' : '缺失' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'size'">
            <span class="text-slate-500">
              {{ record.kind === 'file' && record.size !== null ? record.size + ' 字节' : '—' }}
            </span>
          </template>
          <template v-else-if="column.key === 'path'">
            <span class="text-xs break-all">{{ record.path }}</span>
          </template>
        </template>
      </a-table>
      <div class="text-xs text-slate-400 mt-2">
        安装目录：<span class="break-all">{{ data?.install.dir }}</span>
      </div>
    </a-card>

    <a-card title="上游" :bordered="false" class="mt-4">
      <a-descriptions :column="2" size="small" bordered>
        <a-descriptions-item label="发现端口">
          {{ data?.upstream.port ?? '未发现' }}
        </a-descriptions-item>
        <a-descriptions-item label="归属">
          <a-tag :color="data?.upstream.is_managed ? 'blue' : 'default'">
            {{ data?.upstream.is_managed ? '自建（代理拉起）' : '外部实例' }}
          </a-tag>
        </a-descriptions-item>
      </a-descriptions>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import client from '@/api/client'
import type { AccountData } from '@/api/account'

const data = ref<AccountData | null>(null)

const accountColumns = [
  { title: '账号', key: 'name' },
  { title: '状态', key: 'state' },
  { title: '最后登录', key: 'last' },
  { title: '凭证', key: 'cred', width: '14%' },
]
const checkColumns = [
  { title: '项目', key: 'label', dataIndex: 'label', width: '22%' },
  { title: '状态', key: 'exists', width: '12%' },
  { title: '大小', key: 'size', width: '14%' },
  { title: '路径', key: 'path' },
]

const activeAccount = computed(
  () => data.value?.login.accounts?.find((a) => a.active) ?? null,
)

const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN')

onMounted(async () => {
  const { data: d } = await client.get('/account')
  data.value = d
})
</script>
