<template>
  <div class="page-head">
    <div>
      <h2>{{ title }}</h2>
      <p v-if="sub || $slots.sub" class="sub">
        <slot name="sub">{{ sub }}</slot>
      </p>
    </div>
    <div v-if="$slots.actions" class="actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
// 统一的页头：标题 + 说明 + 右侧操作区。
// 抽出来是因为十个页面各写一遍 <h2> + 说明 + a-space，
// 字号、间距、换行行为会各自漂移。
defineProps<{ title: string; sub?: string }>()
</script>
