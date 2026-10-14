// web/src/utils/chartTheme.ts - 图表统一主题（浅色控制台）
//
// 配色在浅色底上校准：
// 网格/轴退成浅灰，分类色取中饱和度——
// 过亮压不住白底，过深显闷。
//
// 为什么集中一份：三个页面各写一套色值/轴样式，改一处就漏两处，
// 且很容易各自漂移成不同的灰阶和圆角。
//
// 分类色按固定槽位取用，不循环、不按排名重排——「颜色跟着实体走」，
// 否则筛选掉一条序列会让其余序列换色，读者刚建立的对应关系就废了。

/** 分类色槽位（固定顺序，取前 N 个，不循环） */
export const SERIES = ['#0284c7', '#d97706', '#059669', '#db2777'] as const

/** 图表 chrome：网格、轴线、文字，全部退到数据后面 */
export const INK = {
  /** 主文字 */
  primary: '#1e293b',
  /** 次级文字 */
  secondary: '#5c6b80',
  /** 轴标签等弱化文字 */
  muted: '#8b99ad',
  /** 网格线：比表面深一档的细实线，不用虚线 */
  grid: '#e3e8ef',
  /** 基线/轴：再深一档 */
  axis: '#cdd5e0',
  /** 图表表面色（用于间隔与描环，须与卡片底色一致） */
  surface: '#ffffff',
} as const

/** 数值紧凑格式：1.2M / 34K / 567 */
export function compactNum(v: number): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`
  return String(Math.round(v))
}

/** 千分位，用于 tooltip 里的精确值 */
export function exactNum(v: number): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

/**
 * 坐标轴统一样式。
 * 网格线一律细实线（虚线会被读成「阈值/预测」，而它只是网格）。
 */
export function axisStyle(opts: { showGrid?: boolean; formatter?: (v: number) => string } = {}) {
  const { showGrid = true, formatter } = opts
  return {
    axisLine: { show: true, lineStyle: { color: INK.axis } },
    axisTick: { show: false },
    axisLabel: {
      color: INK.muted,
      fontSize: 11,
      ...(formatter ? { formatter } : {}),
    },
    splitLine: {
      show: showGrid,
      lineStyle: { color: INK.grid, type: 'solid' as const, width: 1 },
    },
  }
}

/** 统一的 tooltip 外壳：数值为主、名称次之 */
export const TOOLTIP_BASE = {
  backgroundColor: 'rgba(255,255,255,0.98)',
  borderColor: '#e3e8ef',
  borderWidth: 1,
  padding: [8, 12] as [number, number],
  textStyle: { color: INK.primary, fontSize: 12 },
  extraCssText: 'border-radius:10px;box-shadow:0 10px 28px rgba(16,24,40,0.14);',
}

/** 柱状图：细柱、数据端 4px 圆角、基线端方角 */
export function barSeries(opts: {
  name?: string
  data: number[]
  color: string
  maxWidth?: number
}) {
  const { name, data, color, maxWidth = 22 } = opts
  return {
    ...(name ? { name } : {}),
    type: 'bar' as const,
    data,
    barMaxWidth: maxWidth,
    itemStyle: {
      color,
      borderRadius: [4, 4, 0, 0] as [number, number, number, number],
    },
  }
}

/** 折线图：2px 线宽、圆角接头、不在每个点画标记 */
export function lineSeries(opts: {
  name: string
  data: number[]
  color: string
  area?: boolean
  yAxisIndex?: number
}) {
  const { name, data, color, area = false, yAxisIndex = 0 } = opts
  return {
    name,
    type: 'line' as const,
    data,
    yAxisIndex,
    smooth: true,
    symbol: 'circle',
    symbolSize: 8,
    showSymbol: false,
    lineStyle: { color, width: 2, cap: 'round' as const, join: 'round' as const },
    itemStyle: { color, borderColor: INK.surface, borderWidth: 2 },
    ...(area
      ? {
          areaStyle: {
            color: {
              type: 'linear' as const,
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${color}33` },
                { offset: 1, color: `${color}00` },
              ],
            },
          },
        }
      : {}),
  }
}
