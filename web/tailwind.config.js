/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // 深色控制台配色。slate 槽位被整体改写为「控制台灰阶」：
      // 全站已有 100+ 处 text-slate-400/500 这类工具类，重映射一次
      // 就能把它们全部带到深色语义上，不必逐个页面改类名。
      // 数字越大越亮（沿用 Tailwind 的直觉：400 是正文辅助色）。
      colors: {
        slate: {
          50: '#0d1219',
          100: '#141c28',
          200: '#1c2634',
          300: '#2b3849',
          400: '#7d8ba0', // 辅助文字（原 text-slate-400 的落点）
          500: '#93a1b5', // 次级文字
          600: '#aeb9c9', // 正文偏亮
          700: '#c6cfdb',
          800: '#dde4ec',
          900: '#e8eef7',
        },
        // 状态色在近黑底上要提亮，AntD 默认色值（如 #52c41a）压不住背景
        green: { 400: '#34d399', 500: '#10b981', 600: '#34d399' },
        red: { 400: '#f87171', 500: '#f87171' },
        orange: { 400: '#fbbf24', 500: '#fbbf24' },
      },
      fontFamily: {
        // 数值 / ID / 日志：等宽承载，列对齐后表格读感稳定
        mono: [
          "'JetBrains Mono'", "'Cascadia Mono'", "'SF Mono'", 'Consolas',
          "'Liberation Mono'", 'monospace',
        ],
        // 标题：Bahnschrift 是 Windows 自带的技术向字体，无外部依赖
        display: ["'Bahnschrift'", "'DIN Alternate'", "'Segoe UI Variable Display'", 'sans-serif'],
      },
      boxShadow: {
        panel: '0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px rgba(0,0,0,0.35)',
        glow: '0 0 0 1px rgba(34,211,238,0.28), 0 0 22px rgba(34,211,238,0.16)',
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  },
}
