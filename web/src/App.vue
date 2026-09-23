<template>
  <!-- 全局主题：深色控制台。
       走 ConfigProvider 的 darkAlgorithm 而不是逐个组件写 :deep 覆盖——
       Select 下拉、Modal、DatePicker、Message 这些浮层不在卡片内，
       scoped 样式够不到，只有 token 能一次改干净。 -->
  <a-config-provider :theme="themeConfig" :locale="zhCN">
    <router-view />
  </a-config-provider>
</template>

<script setup lang="ts">
import { theme } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'

// 与 style.css 的 --lab-* 变量同源：这里改一处，AntD 组件和自定义样式一起走。
const themeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#22d3ee',
    colorInfo: '#38bdf8',
    colorSuccess: '#34d399',
    colorWarning: '#fbbf24',
    colorError: '#f87171',

    colorBgBase: '#0a0e14',
    colorBgContainer: '#121824',
    colorBgElevated: '#172030',
    colorBgLayout: '#0a0e14',
    colorBorder: '#212b3b',
    colorBorderSecondary: '#1a2230',

    colorText: '#e8eef7',
    colorTextSecondary: '#93a1b5',
    colorTextTertiary: '#5f6f86',
    colorTextQuaternary: '#44526a',

    borderRadius: 10,
    borderRadiusLG: 14,
    borderRadiusSM: 7,
    controlHeight: 34,
    fontSize: 13,

    // 数据用等宽，正文用无衬线：数字列对齐后整张表稳定得多。
    fontFamily:
      "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    wireframe: false,
  },
  components: {
    Card: { colorBgContainer: '#121824' },
    Table: {
      headerBg: '#151d2a',
      headerColor: '#93a1b5',
      rowHoverBg: '#18202e',
      borderColor: '#1a2230',
    },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(34, 211, 238, 0.14)',
      darkItemSelectedColor: '#22d3ee',
      darkItemColor: '#8b98ad',
      darkItemHoverBg: 'rgba(255,255,255,0.04)',
      darkItemHoverColor: '#e8eef7',
    },
  },
}
</script>
