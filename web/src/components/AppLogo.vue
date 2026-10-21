<template>
  <!-- 网关标记：六边形外框（一个节点） + 中心核 + 三向分流线。
       语义是这套系统的本体——一个入口，分流到多条上游通道。
       用描边而非实心：30px 侧栏与 52px 登录页共用同一份几何，
       缩小时不会糊成一团色块。 -->
  <svg
    class="app-logo"
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    fill="none"
    role="img"
    aria-label="DuMate 控制台"
  >
    <!-- 外框：圆角六边形（一个网关节点）。描边压细压淡一档，
         让内部的分流成为视觉主体 -->
    <path
      d="M16 1.8 28.3 8.9V23.1L16 30.2 3.7 23.1V8.9Z"
      stroke="currentColor"
      stroke-width="2"
      stroke-linejoin="round"
      stroke-opacity="0.5"
    />
    <!-- 三向分流：120° 均布且**等长**（10.8），从中心连通发散。
         断线形态在 16~19px 下中心会糊成一小团噪点，连通的三叉则始终读得出；
         三条线不等长在大尺寸下能明显看出偏斜。 -->
    <g stroke="currentColor" stroke-width="3.2" stroke-linecap="round">
      <path d="M16 16V5.2" />
      <path d="m16 16-9.35 5.4" />
      <path d="m16 16 9.35 5.4" />
    </g>
  </svg>
</template>

<script setup lang="ts">
// 站内唯一的品牌标记。登录页、侧栏、favicon 三处同源——
// 各画一份必然在圆角/粗细上漂移。
withDefaults(defineProps<{ size?: number }>(), { size: 24 })
</script>

<style scoped>
.app-logo {
  display: block;
  flex: none;
}
</style>
