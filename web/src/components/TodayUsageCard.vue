<template>
  <!-- 今日用量。三条通道共用同一套指标——切通道时看到的是同一组数字，
       不用重新适应。数据来自 /usage/overview（按通道过滤的本地网关日志），
       所以三个通道的口径天然一致。
       抽成组件是因为这段标记在三个分支里一模一样，各写一份必然漂移
       （改了一处忘另一处，同一指标在不同通道显示不同）。 -->
  <a-descriptions :column="4" size="small" bordered>
    <a-descriptions-item label="请求数">
      {{ today?.requests ?? '—' }}
      <a-tag v-if="today?.failed" color="red" class="ml-1">失败 {{ today.failed }}</a-tag>
    </a-descriptions-item>
    <a-descriptions-item label="Token">
      {{ today ? fmt(today.tokens) : '—' }}
    </a-descriptions-item>
    <a-descriptions-item label="输入">{{ today ? fmt(today.input_tokens) : '—' }}</a-descriptions-item>
    <a-descriptions-item label="输出">{{ today ? fmt(today.output_tokens) : '—' }}</a-descriptions-item>
    <a-descriptions-item label="成功率">
      <template v-if="today?.success_rate != null">{{ today.success_rate }}%</template>
      <span v-else class="text-slate-400">—</span>
    </a-descriptions-item>
    <a-descriptions-item label="平均耗时">
      <template v-if="today?.avg_ms != null">{{ today.avg_ms }} ms</template>
      <span v-else class="text-slate-400">—</span>
    </a-descriptions-item>
    <a-descriptions-item label="首字延迟">
      <!-- 老日志没有这个字段，样本数不足时如实显示 —，不拿 0 充数
           （那会把均值拉低并给出错误结论） -->
      <template v-if="today?.avg_first_token_ms != null">{{ today.avg_first_token_ms }} ms</template>
      <span v-else class="text-slate-400">—</span>
    </a-descriptions-item>
    <a-descriptions-item label="流式">
      {{ today ? `${today.stream_count} / ${today.requests}` : '—' }}
    </a-descriptions-item>
  </a-descriptions>
</template>

<script setup lang="ts">
import type { UsageToday } from '@/api/usage'

defineProps<{ today: UsageToday | null | undefined }>()

const fmt = (n: number) => n.toLocaleString('zh-CN')
</script>
