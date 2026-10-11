import type { MetricKey } from '../../../shared/analytics'

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat('pt-BR')
const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 2 })

export const UNAVAILABLE = 'indisponível'

export function fmtCount(n: number | null, exact = false): string {
  if (n === null || Number.isNaN(n)) return UNAVAILABLE
  return exact || Math.abs(n) < 10_000 ? full.format(Math.round(n)) : compact.format(n)
}

export function fmtPercent(n: number | null): string {
  return n === null ? UNAVAILABLE : percent.format(n)
}

/** 3 h 20 min, 4 min 12 s, 18 s. */
export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return UNAVAILABLE
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h >= 100 ? `${full.format(h)} h` : `${h} h${m ? ` ${m} min` : ''}`
}

export function fmtMetric(key: MetricKey, value: number | null): string {
  return key === 'watchTimeSeconds' || key === 'averageViewDurationSeconds' ? fmtDuration(value) : fmtCount(value)
}

/** Categorical slots for the dark surface (validated: adjacent CVD ΔE ≥ 8.4, contrast ≥ 3:1). Max 4 series. */
export const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'] as const
