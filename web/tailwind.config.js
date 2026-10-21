/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // 浅色控制台。slate 槽位恢复 Tailwind 原生语义（数字越大越深）：
      // 全站已有 100+ 处 text-slate-400/500 这类工具类，原生值本身就是
      // 浅色语义（400 辅助文字 / 500 次级 / 900 正文深字），不再重映射。
      // 新增页面继续用 slate-*，不要改成语义色名——那等于把这层约定废掉。
      fontFamily: {
        // 数值 / ID / 日志：等宽承载，列对齐后表格读感稳定
        // 仅系统字体，无网络字体（零外部依赖）
        mono: ['Consolas', "'Liberation Mono'", 'monospace'],
        // 标题：Bahnschrift 是 Windows 自带的技术向字体，无外部依赖
        display: ["'Bahnschrift'", "'DIN Alternate'", "'Segoe UI Variable Display'", 'sans-serif'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(16,24,40,0.04), 0 6px 20px rgba(16,24,40,0.06)',
        glow: '0 0 0 1px rgba(8,145,178,0.25), 0 0 18px rgba(8,145,178,0.12)',
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  },
}
