<template>
  <!-- 全局主题：浅色控制台。
       走 ConfigProvider 的默认亮色算法 + token，而不是逐个组件写 :deep 覆盖——
       Select 下拉、Modal、DatePicker、Message 这些浮层不在卡片内，
       scoped 样式够不到，只有 token 能一次改干净。 -->
  <a-config-provider :theme="themeConfig" :locale="zhCN">
    <router-view />
  </a-config-provider>
</template>

<script setup lang="ts">
import zhCN from 'ant-design-vue/es/locale/zh_CN'

// 与 style.css 的 --lab-* 变量同源：这里改一处，AntD 组件和自定义样式一起走。
const themeConfig = {
  token: {
    colorPrimary: '#0891b2',
    colorInfo: '#0284c7',
    colorSuccess: '#059669',
    colorWarning: '#d97706',
    colorError: '#dc2626',

    colorBgBase: '#f4f6f9',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#f4f6f9',
    colorBorder: '#cdd5e0',
    colorBorderSecondary: '#e3e8ef',

    colorText: '#1e293b',
    colorTextSecondary: '#5c6b80',
    colorTextTertiary: '#8b99ad',
    colorTextQuaternary: '#c2cad6',

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
    Card: { colorBgContainer: '#ffffff' },
    Table: {
      headerBg: '#f6f8fb',
      headerColor: '#5c6b80',
      rowHoverBg: '#f1f5f9',
      borderColor: '#e3e8ef',
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemSelectedBg: 'rgba(8, 145, 178, 0.10)',
      itemSelectedColor: '#0891b2',
      itemColor: '#5c6b80',
      itemHoverBg: 'rgba(15, 23, 42, 0.04)',
      itemHoverColor: '#1e293b',
    },
  },
}
</script>
