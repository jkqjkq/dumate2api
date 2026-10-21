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

    colorBgBase: '#f2f4f8',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#f2f4f8',
    colorBorder: '#ccd4df',
    colorBorderSecondary: '#e2e7ee',

    colorText: '#1a2332',
    colorTextSecondary: '#4e5f75',
    colorTextTertiary: '#8494a9',
    colorTextQuaternary: '#bfc9d5',

    // 与 style.css 的 --lab-shadow 同值：AntD 的样式注入晚于全局 CSS，
    // .ant-card 的 box-shadow 若只写在 style.css 会被组件默认值盖掉——
    // 必须在 token 层覆盖 boxShadowTertiary（Card 默认阴影走的就是它）。
    boxShadowTertiary:
      '0 1px 2px rgba(16, 24, 40, 0.04), 0 4px 14px rgba(16, 24, 40, 0.05)',

    borderRadius: 10,
    borderRadiusLG: 14,
    borderRadiusSM: 8,
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
      headerBg: '#f7f9fc',
      headerColor: '#4e5f75',
      rowHoverBg: '#eef2f7',
      borderColor: '#e2e7ee',
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemSelectedBg: 'rgba(8, 145, 178, 0.08)',
      itemSelectedColor: '#0891b2',
      itemColor: '#4e5f75',
      itemHoverBg: 'rgba(15, 23, 42, 0.04)',
      itemHoverColor: '#1a2332',
    },
  },
}
</script>
