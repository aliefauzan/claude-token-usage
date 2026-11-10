import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Breakdown, Chat, Day, Meta, Quad, Range, Tab, Usage } from '../types'

const PANE = 'token-usage'
const TITLE = 'Token usage'
const REFRESH_MS = 5 * 60 * 1000

// Change the tag when Usage's fields change: it declines what an earlier
// version stored, which outlives a reload.
const usage = atom({ plugin: 'token-usage', key: 'usage' } as const, null, {
  shape: 'usage-5',
})
const status = atom({ plugin: 'token-usage', key: 'status' } as const, {
  isLoading: false,
  error: null,
})
const tabAtom = atom({ plugin: 'token-usage', key: 'tab' } as const, 'overview' as Tab)
const rangeAtom = atom({ plugin: 'token-usage', key: 'range' } as const, 'all' as Range)
const breakdownAtom = atom({ plugin: 'token-usage', key: 'breakdown' } as const, 'feature' as Breakdown)
const openProjectAtom = atom({ plugin: 'token-usage', key: 'openProject' } as const, null as string | null)
const projectRowsAtom = atom({ plugin: 'token-usage', key: 'projectRows' } as const, 6)

const EMPTY = '#55555a'
const BLUES = ['#c6e0ff', '#8ec1ff', '#4f97ff', '#1a62f0'] as const
const ACCENT = '#4f97ff'
const TODAY_RING = '#d97757'
const ZERO: Quad = [0, 0, 0, 0]

/** Rough token lengths of well-known books, for the footer's comparison. */
const BOOKS: [string, number][] = [
  ['The Little Prince', 22_000],
  ['The Great Gatsby', 65_000],
  ["Harry Potter and the Philosopher's Stone", 105_000],
  ['Moby-Dick', 285_000],
  ['The Lord of the Rings', 640_000],
  ['War and Peace', 760_000],
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Every token, cache reads included. */
const sum = (q: Quad) => q[0] + q[1] + q[2] + q[3]
const addQuad = (a: Quad, b: Quad): Quad => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]

export const fmt = (n: number): string => {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size
      return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${unit}`
    }
  }
  return String(Math.round(n))
}

export const commas = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export const usd = (n: number) => (n >= 100 ? `$${commas(n)}` : `$${n.toFixed(2)}`)

/** `n` local dates ending at `today`, oldest first. */
export const lastDays = (today: string, n: number): string[] => {
  const [y = 1970, m = 1, d = 1] = today.split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10))
  }
  return out
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()
const monthOf = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1] ?? date.slice(5, 7)

export const prettyModel = (id: string): string => {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const modern = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (modern) return `${cap(modern[1] ?? '')} ${modern[2]}${modern[3] ? `.${modern[3]}` : ''}`
  const legacy = /^claude-(\d+)(?:-(\d))?-([a-z]+)/.exec(id)
  if (legacy) return `${cap(legacy[3] ?? '')} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ''}`
  return id.replace(/^claude-/, '')
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`

const dayTokens = (data: Usage, date: string): Quad => data.days[date]?.t ?? ZERO

const isActive = (day: Day | undefined) => day !== undefined && (day.msgs > 0 || sum(day.t) > 0)

export const duration = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return [d ? `${d}d` : '', h || d ? `${h}h` : '', `${m % 60}m`].filter(Boolean).join(' ')
}

export type Summary = {
  tokens: Quad
  cost: number
  sessions: number
  messages: number
  activeDays: number
  /** Days the range spans: since the first session for all time, as /stats counts them. */
  spanDays: number
  currentStreak: number
  longestStreak: number
  peakHour: number | null
  mostActiveDay: string | null
  models: { id: string; tokens: Quad; cost: number }[]
}

/** The figures of the Overview and Models tabs over `range`, ending today. */
/** Days the range covers, ending today; all time starts at the first session. */
const spanOf = (data: Usage, range: Range): number => {
  if (range === '7d') return 7
  if (range === '30d') return 30
  const first = data.meta.firstDay ?? Object.keys(data.days).sort()[0] ?? data.today
  return Math.max(1, Math.round((Date.parse(data.today) - Date.parse(first)) / 86_400_000) + 1)
}

export const summarize = (data: Usage, range: Range): Summary => {
  const span = spanOf(data, range)
  const firstAt = data.meta.firstSessionAt ? Date.parse(data.meta.firstSessionAt) : NaN
  const spanDays =
    range === 'all' && Number.isFinite(firstAt) && data.updatedAt > firstAt
      ? Math.ceil((data.updatedAt - firstAt) / 86_400_000) + 1
      : span

  let tokens: Quad = ZERO
  let cost = 0
  let messages = 0
  let sessions = 0
  let activeDays = 0
  let run = 0
  let longestStreak = 0
  let mostActiveDay: string | null = null
  let mostMessages = 0
  const hours: Record<string, number> = {}
  const models: Record<string, { tokens: Quad; cost: number }> = {}

  for (const date of lastDays(data.today, span)) {
    const day: Day | undefined = data.days[date]
    run = isActive(day) ? run + 1 : 0
    longestStreak = Math.max(longestStreak, run)
    if (!day) continue
    if (isActive(day)) activeDays += 1
    tokens = addQuad(tokens, day.t)
    cost += day.c ?? 0
    messages += day.msgs
    sessions += day.sess
    if (day.msgs > mostMessages) {
      mostMessages = day.msgs
      mostActiveDay = date
    }
    for (const [h, n] of Object.entries(day.h)) hours[h] = (hours[h] ?? 0) + n
    for (const [m, q] of Object.entries(day.m)) {
      const prev = models[m] ?? { tokens: ZERO, cost: 0 }
      models[m] = { tokens: addQuad(prev.tokens, q), cost: prev.cost + (day.mc?.[m] ?? 0) }
    }
  }

  // Current streak counts back from today, or from yesterday while today is quiet.
  let currentStreak = 0
  const back = lastDays(data.today, 3660).reverse()
  const startAt = isActive(data.days[data.today]) ? 0 : 1
  for (const date of back.slice(startAt)) {
    if (isActive(data.days[date])) currentStreak += 1
    else break
  }

  const hourSource = range === 'all' && Object.keys(data.meta.hours).length ? data.meta.hours : hours
  const peak = Object.entries(hourSource).sort((a, b) => b[1] - a[1])[0]

  return {
    tokens,
    cost,
    sessions,
    messages,
    activeDays,
    spanDays,
    currentStreak,
    longestStreak,
    peakHour: peak ? Number(peak[0]) : null,
    mostActiveDay,
    models: Object.entries(models)
      .map(([id, m]) => ({ id, ...m }))
      // Favorite model is the one with the most tokens, as /stats picks it.
      .sort((a, b) => sum(b.tokens) - sum(a.tokens)),
  }
}

export type Pace = {
  today: { tokens: Quad; cost: number }
  month: { tokens: Quad; cost: number }
  /** Mean new-work tokens over the active days of the 30 before today; null with none. */
  dailyAverage: number | null
  /** Today's tokens over the daily average; null with no average. */
  ratio: number | null
  /** This month's tokens and cost carried to the month's end at its pace so far. */
  projected: { tokens: number; cost: number }
}

/** Today and this month, against the usual. */
export const pace = (data: Usage): Pace => {
  const ym = data.today.slice(0, 7)
  let month: Quad = ZERO
  let monthCost = 0
  for (const [date, day] of Object.entries(data.days)) {
    if (!date.startsWith(ym)) continue
    month = addQuad(month, day.t)
    monthCost += day.c ?? 0
  }
  const before = lastDays(data.today, 31).slice(0, 30)
  const active = before.map(d => data.days[d]).filter((d): d is Day => isActive(d))
  const dailyAverage = active.length ? active.reduce((n, d) => n + sum(d.t), 0) / active.length : null
  const today = dayTokens(data, data.today)
  const [y = 1970, m = 1, dom = 1] = data.today.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const scale = daysInMonth / dom
  return {
    today: { tokens: today, cost: data.days[data.today]?.c ?? 0 },
    month: { tokens: month, cost: monthCost },
    dailyAverage,
    ratio: dailyAverage ? sum(today) / dailyAverage : null,
    projected: { tokens: sum(month) * scale, cost: monthCost * scale },
  }
}

export const compareLabel = (ratio: number | null): string => {
  if (ratio === null) return 'no recent days to compare'
  if (ratio >= 1.1) return `↑ ${ratio.toFixed(1)}× your daily average`
  if (ratio <= 0.9) return `↓ ${ratio.toFixed(1)}× your daily average`
  return 'about your daily average'
}

/** The heatmap's tiles: a column per week, Sunday on top, today in the last column. */
export const heatmapCells = (data: Usage, weeks: number) => {
  const lastRow = weekday(data.today)
  const dates = lastDays(data.today, weeks * 7 - (6 - lastRow))
  const totals = dates.map(d => sum(dayTokens(data, d)))
  const sorted = totals.filter(v => v > 0).sort((a, b) => a - b)
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  const cuts = [q(0.25), q(0.5), q(0.75)] as const
  const shade = (v: number): string =>
    v <= 0 ? EMPTY : BLUES[v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3]
  return dates.map((date, i) => ({
    date,
    col: Math.floor(i / 7),
    row: i % 7,
    total: totals[i] ?? 0,
    color: shade(totals[i] ?? 0),
  }))
}

/** Columns where a new month starts, with its short name; none closer than 3 columns. */
export const monthLabels = (cells: { date: string; col: number; row: number }[]) => {
  const out: { col: number; label: string }[] = []
  let last = ''
  for (const c of cells) {
    if (c.row !== 0 && c.col !== 0) continue
    const m = c.date.slice(0, 7)
    if (m === last) continue
    last = m
    const prev = out[out.length - 1]
    if (prev && c.col - prev.col < 3) out.pop()
    out.push({ col: c.col, label: monthOf(c.date) })
  }
  // A label in the first column whose month started before the grid is cut short by the next.
  if (out.length > 1 && (out[1]?.col ?? 0) - (out[0]?.col ?? 0) < 3) out.shift()
  return out
}

const longDate = (date: string) =>
  `${WEEKDAYS[weekday(date)]}, ${monthOf(date)} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`

const TILE = 13
const GAP = 3
const STEP = TILE + GAP
const LEFT = 30
const TOP = 16
const ROW_H = 20

/** The click/hover line for one day. */
export const dayLabel = (data: Usage, date: string): string => {
  const day = data.days[date]
  if (!day || !isActive(day)) return `${longDate(date)} &#183; no usage`
  return (
    `${longDate(date)} &#183; ${fmt(sum(day.t))} tokens &#183; ~${usd(day.c ?? 0)}`
  )
}

/**
 * The heatmap as SVG markup for the graphical surfaces: month names on top,
 * Mon/Wed/Fri down the side, a Less-More key under it, today ringed. Each
 * day is a focusable group: hovering or clicking it shows the day on the line
 * under the grid (CSS only: the frame runs no script), and `<title>` gives the
 * native tooltip too.
 */
export const heatmapSvg = (data: Usage, weeks: number): string => {
  const cells = heatmapCells(data, weeks)
  const gridW = weeks * STEP - GAP
  const width = LEFT + gridW
  const gridBottom = TOP + 7 * STEP - GAP
  const legendY = gridBottom + 16
  const tipY = legendY + TILE + ROW_H
  const height = tipY + 6
  const css = [
    'text{font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#9a9aa0}',
    '.tip,.hint{font-size:12px}',
    '.d{cursor:pointer;outline:none}',
    '.d .tip{visibility:hidden;fill:#e8e8ea;font-weight:600}',
    `.today{stroke:${TODAY_RING};stroke-width:2}`,
    '.d:hover rect,.d:focus rect{stroke:#fff;stroke-width:1.5}',
    '.d:hover .tip,.d:focus .tip{visibility:visible}',
    'svg:has(.d:hover) .d:focus:not(:hover) .tip{visibility:hidden}',
    'svg:has(.d:hover) .d:focus:not(:hover) rect:not(.today){stroke:none}',
    'svg:has(.d:hover) .hint,svg:has(.d:focus) .hint{visibility:hidden}',
  ].join('')

  const months = monthLabels(cells)
    .map(m => `<text x="${LEFT + m.col * STEP}" y="${TOP - 5}">${m.label}</text>`)
    .join('')
  const days = [1, 3, 5]
    .map(r => `<text x="0" y="${TOP + r * STEP + TILE - 2}">${WEEKDAYS[r]}</text>`)
    .join('')
  const legendX = width - (5 * STEP - GAP) - 36
  const legend =
    `<text x="${legendX - 30}" y="${legendY + 10}">Less</text>` +
    [EMPTY, ...BLUES]
      .map((c, i) => `<rect x="${legendX + i * STEP}" y="${legendY}" width="${TILE}" height="${TILE}" rx="3" fill="${c}"/>`)
      .join('') +
    `<text x="${legendX + 5 * STEP + 2}" y="${legendY + 10}">More</text>`

  const tiles = cells
    .map(c => {
      const label = dayLabel(data, c.date)
      const isToday = c.date === data.today
      return (
        `<g class="d" tabindex="0"><title>${label}</title>` +
        `<rect${isToday ? ' class="today"' : ''} x="${LEFT + c.col * STEP}" y="${TOP + c.row * STEP}" width="${TILE}" height="${TILE}" rx="3" fill="${c.color}"/>` +
        `<text class="tip" x="0" y="${tipY}">${label}</text></g>`
      )
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${css}</style>${months}${days}${legend}${tiles}` +
    `<text class="hint" x="0" y="${tipY}">Click a day to see its tokens</text></svg>`
  )
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!
    out += c === undefined ? '=' : B64[n & 63]!
  }
  return out
}

const RASTER_LEFT = 4

/**
 * The heatmap as Raster cells for the terminal: month names on the first row,
 * Mon/Wed/Fri down the side, a block per day with a space between weeks, and
 * today drawn as a hollow block.
 */
export const heatmapRaster = (data: Usage, weeks: number) => {
  const columns = RASTER_LEFT + weeks * 2 - 1
  const rows = 8
  const DEFAULT = 0x01000000
  const DIM = 0x9a9aa0
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) words.set([0x20, DEFAULT, DEFAULT], i * 3)
  const write = (row: number, col: number, text: string, fg: number) => {
    for (let i = 0; i < text.length && col + i < columns; i++) {
      words.set([text.charCodeAt(i), fg, DEFAULT], (row * columns + col + i) * 3)
    }
  }
  const cells = heatmapCells(data, weeks)
  for (const m of monthLabels(cells)) write(0, RASTER_LEFT + m.col * 2, m.label, DIM)
  for (const r of [1, 3, 5]) write(r + 1, 0, WEEKDAYS[r] ?? '', DIM)
  for (const c of cells) {
    const glyph = c.date === data.today ? 0x25a3 : 0x25a0
    const at = ((c.row + 1) * columns + RASTER_LEFT + c.col * 2) * 3
    words.set([glyph, parseInt(c.color.slice(1), 16), DEFAULT], at)
  }
  return { columns, rows, cells: toBase64(new Uint8Array(words.buffer)) }
}

// Analytics charts. Categorical hues in a fixed order, stepped for a dark surface.
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const
const OTHER = '#8a8a90'
const OLDER = '#55555a'
/** Features keep their colour whatever the range holds. */
const FEATURE_COLORS: Record<string, string> = {
  Chats: SERIES[0],
  Subagents: SERIES[1],
  Scheduled: SERIES[2],
}
const OLDER_LOGS = 'Older logs'

export type Bucket = { start: string; end: string; values: Record<string, number>; total: number }
export type SeriesKey = { key: string; label: string; color: string; total: number }
export type Series = {
  unit: 'day' | 'week' | 'month'
  buckets: Bucket[]
  keys: SeriesKey[]
  total: number
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const total = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0)

/**
 * A day's tokens split by a transcript breakdown: the shares come from the
 * transcripts, the total from the day, so the bars add up to the Overview.
 * A day with no transcripts left is all "Older logs".
 */
export const scaled = (day: Day, shares: Record<string, number> | undefined): Record<string, number> => {
  const all = sum(day.t)
  if (!all) return {}
  const known = total(shares)
  if (!known || !shares) return { [OLDER_LOGS]: all }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(shares)) out[k] = (v * all) / known
  return out
}

const startOfWeek = (date: string) => lastDays(date, weekday(date) + 1)[0] ?? date

/**
 * The range's days in buckets: a bar a day up to a month, a week up to half
 * a year, else a month. The `top` largest keys keep their own colour; the
 * rest fold into "Other".
 */
export const series = (
  data: Usage,
  range: Range,
  pick: (day: Day) => Record<string, number> | undefined,
  opts: { top?: number; label?: (key: string) => string; fixed?: Record<string, string> } = {},
): Series => {
  const top = opts.top ?? 5
  const dates = lastDays(data.today, spanOf(data, range))
  const unit = dates.length <= 31 ? 'day' : dates.length <= 26 * 7 ? 'week' : 'month'
  const keyOf = (d: string) => (unit === 'day' ? d : unit === 'week' ? startOfWeek(d) : d.slice(0, 7))
  const buckets: Bucket[] = []
  const totals: Record<string, number> = {}
  for (const date of dates) {
    const k = keyOf(date)
    let b = buckets[buckets.length - 1]
    if (!b || keyOf(b.start) !== k) {
      b = { start: date, end: date, values: {}, total: 0 }
      buckets.push(b)
    }
    b.end = date
    const day = data.days[date]
    if (!day) continue
    for (const [key, v] of Object.entries(pick(day) ?? {})) {
      if (!v) continue
      b.values[key] = (b.values[key] ?? 0) + v
      b.total += v
      totals[key] = (totals[key] ?? 0) + v
    }
  }
  const ranked = Object.entries(totals)
    .filter(([k]) => k !== OLDER_LOGS)
    .sort((a, b) => b[1] - a[1])
  const kept = new Set(ranked.slice(0, ranked.length > top + 1 ? top : top + 1).map(([k]) => k))
  const folded = ranked.filter(([k]) => !kept.has(k))
  if (folded.length) {
    for (const b of buckets) {
      let other = 0
      for (const [k] of folded) {
        other += b.values[k] ?? 0
        delete b.values[k]
      }
      if (other) b.values.Other = other
    }
  }
  const label = opts.label ?? ((k: string) => k)
  const keys: SeriesKey[] = ranked
    .filter(([k]) => kept.has(k))
    .map(([key, t], i) => ({ key, label: label(key), color: opts.fixed?.[key] ?? SERIES[i % SERIES.length]!, total: t }))
  if (folded.length) {
    keys.push({ key: 'Other', label: 'Other', color: OTHER, total: folded.reduce((n, [, v]) => n + v, 0) })
  }
  if (totals[OLDER_LOGS]) {
    keys.push({ key: OLDER_LOGS, label: OLDER_LOGS, color: OLDER, total: totals[OLDER_LOGS] })
  }
  return { unit, buckets, keys, total: keys.reduce((n, k) => n + k.total, 0) }
}

const shortDate = (date: string) => `${monthOf(date)} ${Number(date.slice(8, 10))}`

export const bucketLabel = (s: Series, b: Bucket) =>
  s.unit === 'month'
    ? `${monthOf(b.start)} ${b.start.slice(0, 4)}`
    : s.unit === 'week'
      ? `${shortDate(b.start)} – ${shortDate(b.end)}`
      : shortDate(b.start)

/** "Oct 12 – Nov 10, 2026" */
export const rangeLabel = (data: Usage, range: Range) => {
  const dates = lastDays(data.today, spanOf(data, range))
  const first = dates[0] ?? data.today
  const sameYear = first.slice(0, 4) === data.today.slice(0, 4)
  return `${shortDate(first)}${sameYear ? '' : `, ${first.slice(0, 4)}`} – ${shortDate(data.today)}, ${data.today.slice(0, 4)}`
}

/** A round axis top a little above `max`, with 3 equal steps. */
const niceTop = (max: number) => {
  if (max <= 0) return 3
  const raw = max / 3
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => m * pow).find(v => v >= raw) ?? 10 * pow
  return step * 3
}

const C_AXIS = 40
const C_TOP = 10
const C_PLOT = 120

/**
 * A bar chart (stacked) or line chart as SVG, full width with the value axis
 * on the right. The line under it shows the latest bucket; hovering or
 * clicking a bar shows that bar instead, by CSS alone.
 */
export const chartSvg = (
  s: Series,
  width: number,
  kind: 'bars' | 'lines',
  value: (n: number) => string,
): string => {
  const W = Math.max(200, Math.round(width))
  const plotW = W - C_AXIS
  const base = C_TOP + C_PLOT
  const xLabelY = base + 16
  const tipY = xLabelY + 22
  const H = tipY + 4
  const n = Math.max(1, s.buckets.length)
  const slot = plotW / n
  const peak =
    kind === 'bars'
      ? Math.max(0, ...s.buckets.map(b => b.total))
      : Math.max(0, ...s.buckets.flatMap(b => Object.values(b.values)))
  const yTop = niceTop(peak)
  const y = (v: number) => base - (v / yTop) * C_PLOT
  const order = s.keys.map(k => k.key)
  const colorOf = Object.fromEntries(s.keys.map(k => [k.key, k.color]))
  const labelOf = Object.fromEntries(s.keys.map(k => [k.key, k.label]))

  const css = [
    'text{font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#8e8e93;font-variant-numeric:tabular-nums}',
    '.tip,.now{font-size:12px}',
    '.now{fill:#8e8e93}',
    '.d{cursor:pointer;outline:none}',
    '.d .tip{visibility:hidden;fill:#f2f2f7;font-weight:600}',
    '.d .x{visibility:hidden}',
    '.d:hover .tip,.d:focus .tip,.d:hover .x,.d:focus .x{visibility:visible}',
    'svg:has(.d:hover) .d:focus:not(:hover) .tip,svg:has(.d:hover) .d:focus:not(:hover) .x{visibility:hidden}',
    '.seg{transition:opacity .12s ease-out}',
    'svg:has(.d:hover) .d:not(:hover) .seg,svg:has(.d:focus) .d:not(:focus) .seg{opacity:.4}',
    'svg:has(.d:hover) .now,svg:has(.d:focus) .now{visibility:hidden}',
  ].join('')

  const grid = [0, 1, 2, 3]
    .map(i => {
      const v = (yTop / 3) * i
      const gy = y(v)
      return (
        `<line x1="0" x2="${plotW}" y1="${gy}" y2="${gy}" stroke="${i === 0 ? '#48484a' : '#2c2c2e'}" stroke-width="1"/>` +
        `<text x="${W}" y="${gy + 4}" text-anchor="end">${i === 0 ? '0' : esc(value(v))}</text>`
      )
    })
    .join('')

  const ticks = [...new Set([0, Math.floor((n - 1) / 2), n - 1])]
    .map(i => {
      const b = s.buckets[i]
      if (!b) return ''
      const label = s.unit === 'month' ? monthOf(b.start) : shortDate(b.start)
      const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'
      const x = anchor === 'start' ? slot * i : anchor === 'end' ? slot * (i + 1) : slot * (i + 0.5)
      return `<text x="${x.toFixed(1)}" y="${xLabelY}" text-anchor="${anchor}">${label}</text>`
    })
    .join('')

  const tipOf = (b: Bucket) => {
    const parts = Object.entries(b.values)
      .sort((a, c) => c[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) =>
        kind === 'bars' && b.total ? `${labelOf[k] ?? k} ${Math.round((v / b.total) * 100)}%` : `${labelOf[k] ?? k} ${value(v)}`,
      )
    const head = [bucketLabel(s, b), value(b.total)]
    if (parts.length && s.keys.length > 1) head.push(parts.join(', '))
    return head.map(esc).join(' &#183; ')
  }

  const barW = Math.min(24, Math.max(2, slot * 0.6))
  const lines =
    kind === 'lines'
      ? [...order]
          .reverse()
          .map(k => {
            const pts = s.buckets.map((b, i) => `${(slot * (i + 0.5)).toFixed(1)},${y(b.values[k] ?? 0).toFixed(1)}`)
            return pts.length === 1
              ? `<circle cx="${pts[0]!.split(',')[0]}" cy="${pts[0]!.split(',')[1]}" r="4" fill="${colorOf[k]}"/>`
              : `<polyline points="${pts.join(' ')}" fill="none" stroke="${colorOf[k]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
          })
          .join('')
      : ''

  const groups = s.buckets
    .map((b, i) => {
      const x0 = slot * i
      let marks = ''
      if (kind === 'bars') {
        const bx = x0 + (slot - barW) / 2
        let cursor = base
        const present = order.filter(k => (b.values[k] ?? 0) > 0)
        present.forEach((k, j) => {
          const h = ((b.values[k] ?? 0) / yTop) * C_PLOT
          const gap = j < present.length - 1 && h > 3 ? 1.5 : 0
          const top = cursor - h
          marks += `<rect class="seg" x="${bx.toFixed(1)}" y="${(top + gap).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, h - gap).toFixed(1)}" rx="${Math.min(3, barW / 4).toFixed(1)}" fill="${colorOf[k]}"/>`
          cursor = top
        })
      } else {
        const cx = x0 + slot / 2
        marks =
          `<line class="x" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${C_TOP}" y2="${base}" stroke="#8e8e93" stroke-width="1"/>` +
          order
            .filter(k => (b.values[k] ?? 0) > 0)
            .map(k => `<circle class="x" cx="${cx.toFixed(1)}" cy="${y(b.values[k] ?? 0).toFixed(1)}" r="3.5" fill="${colorOf[k]}" stroke="#1c1c1e" stroke-width="2"/>`)
            .join('')
      }
      const tip = tipOf(b)
      return (
        `<g class="d" tabindex="0"><title>${tip}</title>` +
        `<rect x="${x0.toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${base}" fill="transparent"/>` +
        `${marks}<text class="tip" x="0" y="${tipY}">${tip}</text></g>`
      )
    })
    .join('')

  const latest = [...s.buckets].reverse().find(b => b.total > 0)
  const now = latest ? `<text class="now" x="0" y="${tipY}">${tipOf(latest)}</text>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<style>${css}</style>${grid}${ticks}${now}${lines}${groups}</svg>`
  )
}

/**
 * A stacked bar chart as Raster cells for the terminal: 8 rows of bars drawn
 * in eighth blocks, coloured by the series under each cell, and a row of
 * dates under them.
 */
export const chartRaster = (s: Series, columns: number) => {
  const rows = 8
  const n = Math.max(1, s.buckets.length)
  const w = Math.max(1, Math.floor(columns / n))
  const cols = Math.max(1, Math.min(columns, w * n))
  const DEFAULT = 0x01000000
  const words = new Uint32Array(cols * (rows + 1) * 3)
  for (let i = 0; i < cols * (rows + 1); i++) words.set([0x20, DEFAULT, DEFAULT], i * 3)
  const peak = Math.max(1, ...s.buckets.map(b => b.total))
  const order = s.keys.map(k => k.key)
  const colorOf = Object.fromEntries(s.keys.map(k => [k.key, parseInt(k.color.slice(1), 16)]))
  s.buckets.forEach((b, i) => {
    const eighths = Math.round((b.total / peak) * rows * 8)
    // Each series' upper edge, in eighths from the bottom.
    let acc = 0
    const edges = order
      .filter(k => (b.values[k] ?? 0) > 0)
      .map(k => {
        acc += b.values[k] ?? 0
        return { k, edge: (acc / b.total) * eighths }
      })
    for (let r = 0; r < rows; r++) {
      const fill = Math.min(8, eighths - r * 8)
      if (fill <= 0) break
      const mid = r * 8 + fill / 2
      const k = edges.find(e => e.edge >= mid)?.k ?? edges[edges.length - 1]?.k
      const glyph = fill >= 8 ? 0x2588 : 0x2580 + fill
      const fg = (k ? colorOf[k] : undefined) ?? 0x3987e5
      for (let c = 0; c < (w >= 2 ? w - 1 : 1); c++) {
        words.set([glyph, fg, DEFAULT], ((rows - 1 - r) * cols + i * w + c) * 3)
      }
    }
  })
  const write = (col: number, text: string) => {
    for (let i = 0; i < text.length && col + i < cols; i++) {
      if (col + i < 0) continue
      words.set([text.charCodeAt(i), 0x9a9aa0, DEFAULT], (rows * cols + col + i) * 3)
    }
  }
  const first = s.buckets[0]
  const last = s.buckets[s.buckets.length - 1]
  const name = (b: Bucket) => (s.unit === 'month' ? monthOf(b.start) : shortDate(b.start))
  if (first) write(0, name(first))
  if (last && last !== first) write(cols - name(last).length, name(last))
  return { columns: cols, rows: rows + 1, cells: toBase64(new Uint8Array(words.buffer)) }
}

/** The chats that started in the range, largest first. */
export const chatsIn = (data: Usage, range: Range): Chat[] => {
  const since = lastDays(data.today, spanOf(data, range))[0] ?? data.today
  return data.chats.filter(c => c.day >= since).sort((a, b) => b.tokens - a.tokens)
}

/** Projects by tokens over the range, as the Usage history chart splits them, each with its chats. */
export const projectsIn = (data: Usage, range: Range) => {
  const totals: Record<string, number> = {}
  for (const date of lastDays(data.today, spanOf(data, range))) {
    const day = data.days[date]
    if (!day) continue
    for (const [k, v] of Object.entries(scaled(day, day.p))) totals[k] = (totals[k] ?? 0) + v
  }
  const chats = chatsIn(data, range)
  return Object.entries(totals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, tokens]) => ({ name, tokens, chats: chats.filter(c => c.project === name) }))
}

/** What a project's open row shows: its chats' count, subagents, main model and surface, and last day. */
export const projectInfo = (chats: Chat[]) => {
  const top = (pick: (c: Chat) => string) => {
    const by: Record<string, number> = {}
    for (const c of chats) by[pick(c)] = (by[pick(c)] ?? 0) + c.tokens
    return Object.entries(by).sort((a, b) => b[1] - a[1])[0]?.[0]
  }
  return {
    chats: chats.length,
    subagents: chats.reduce((n, c) => n + c.subagents, 0),
    model: top(c => c.model),
    surface: top(c => c.surface),
    last: chats.reduce<string | undefined>((d, c) => (!d || c.day > d ? c.day : d), undefined),
  }
}

export const pct = (share: number) => {
  const p = share * 100
  return p > 0 && p < 0.01 ? '<0.01%' : `${p.toFixed(2)}%`
}

const truncate = (text: string, n: number) => (text.length > n ? `${text.slice(0, Math.max(1, n - 1))}…` : text)

let isRunning = false
let timer: { cancel: () => void } | undefined

async function refresh($: EngineInterface): Promise<void> {
  if (isRunning) return
  isRunning = true
  await update($, status, s => ({ ...s, isLoading: true }))
  try {
    const script = `${$.plugin.root}/scripts/aggregate.py`
    let ran = await $.process
      .run(['/usr/bin/env', 'python3', script], { timeoutMs: 300_000 })
      .catch(() => undefined)
    if (!ran || ran.exitCode !== 0) {
      ran = await $.process.run(['/usr/bin/python3', script], { timeoutMs: 300_000 })
    }
    if (ran.exitCode !== 0) {
      throw new Error(ran.stderr.trim().split('\n').pop() || `exit ${ran.exitCode}`)
    }
    const raw = JSON.parse(ran.stdout) as {
      today: string
      meta: Meta
      days: Record<string, Day>
      chats?: Chat[]
    }
    const next: Usage = {
      today: raw.today,
      meta: raw.meta,
      days: raw.days,
      chats: raw.chats ?? [],
      updatedAt: await $.clock.now(),
    }
    await update($, usage, () => next)
    await update($, status, () => ({ isLoading: false, error: null }))
    const p = pace(next)
    $.ui.status(
      `Today ${fmt(sum(p.today.tokens))} ~${usd(p.today.cost)} · ` +
        `${monthOf(next.today)} ${fmt(sum(p.month.tokens))} ~${usd(p.month.cost)}`,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, status, () => ({ isLoading: false, error: message }))
  } finally {
    isRunning = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-usage',
      description: 'Show daily and monthly token usage in a pane',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.after(0, () => void refresh($))
    timer?.cancel()
    timer = $.clock.every(REFRESH_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'token-usage' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    $.clock.after(0, () => void refresh($))

    return { text: 'Token usage pane opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    $.clock.after(2000, () => void refresh($))

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await read($, usage)
    const { isLoading, error } = await read($, status)
    const tab = await read($, tabAtom)
    const range = await read($, rangeAtom)
    const breakdown = await read($, breakdownAtom)
    const openProject = await read($, openProjectAtom)
    const projectRows = await read($, projectRowsAtom)
    const cols = Math.max(24, e.props.bodyColumns ?? 40)

    const refreshButton = (
      <Button
        key="refresh"
        plain
        dimColor
        label={isLoading ? 'Refreshing…' : 'Refresh'}
        onPress={() => void refresh($)}
      />
    )

    if (!data) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>
            {error
              ? `Could not read usage: ${error}`
              : 'Reading transcripts… the first scan can take a few seconds.'}
          </Text>
          {refreshButton}
        </Box>
      )
    }

    const s = summarize(data, range)
    const p = pace(data)

    const tabButton = (id: Tab, label: string) => (
      <Button
        key={`tab-${id}`}
        label={label}
        variant={tab === id ? 'primary' : 'secondary'}
        onPress={() => void update($, tabAtom, () => id)}
      />
    )
    const rangeButton = (id: Range, label: string) => (
      <Button
        key={`range-${id}`}
        label={label}
        plain
        dimColor={range !== id}
        onPress={() => void update($, rangeAtom, () => id)}
      />
    )

    const card = (label: string, value: string, ...notes: (string | null)[]) => (
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        width="50%"
        borderStyle="round"
        borderDimColor
        paddingX={1}
      >
        <Text dimColor wrap="truncate-end">
          {label}
        </Text>
        <Text bold wrap="truncate-end">
          {value}
        </Text>
        {notes
          .filter((n): n is string => n !== null)
          .map(n => (
            <Text dimColor wrap="truncate-end">
              {n}
            </Text>
          ))}
      </Box>
    )
    const cardRow = (...cards: ReturnType<typeof card>[]) => (
      <Box flexDirection="row" gap={1}>
        {cards}
      </Box>
    )

    // A pane column is about 8.5 CSS pixels on the graphical surfaces.
    let heatmap = null
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const weeks = Math.max(4, Math.min(53, Math.floor((cols - RASTER_LEFT + 1) / 2)))
      heatmap = (
        <Box flexDirection="column">
          <Raster key="heatmap" {...heatmapRaster(data, weeks)} />
          <Text dimColor>
            Less <Text color={EMPTY}>■</Text>
            {BLUES.map(c => (
              <Text color={c}>■</Text>
            ))}{' '}
            More · <Text color={TODAY_RING}>▣</Text> today
          </Text>
        </Box>
      )
    } else {
      const table = $.ui.resolve(e)
      if ('Svg' in table) {
        const { Svg } = table
        const weeks = Math.max(4, Math.min(53, Math.floor((cols * 8.5 - LEFT + GAP) / STEP)))
        heatmap = (
          <Svg
            source={heatmapSvg(data, weeks)}
            alt={`Daily token heatmap, last ${weeks} weeks`}
            isInteractive
          />
        )
      }
    }

    const total = sum(s.tokens)
    const book = BOOKS[Number(data.today.slice(8, 10)) % BOOKS.length] ?? BOOKS[0]!
    const times = Math.round(total / book[1])
    const footer =
      times >= 2 ? (
        <Text dimColor>
          You've used ~{commas(times)}× more tokens than {book[0]}.
        </Text>
      ) : null

    const rangeName = range === 'all' ? 'all time' : `last ${range}`
    const overview = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {cardRow(
            card(
              'Today',
              `${fmt(sum(p.today.tokens))} · ~${usd(p.today.cost)}`,
              compareLabel(p.ratio),
            ),
            card(
              `${monthOf(data.today)} so far`,
              `${fmt(sum(p.month.tokens))} · ~${usd(p.month.cost)}`,
              `on pace for ${fmt(p.projected.tokens)} · ~${usd(p.projected.cost)}`,
            ),
          )}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>{rangeName.toUpperCase()}</Text>
          {cardRow(
            card('Favorite model', s.models[0] ? prettyModel(s.models[0].id) : '–'),
            card('Total tokens', fmt(total), `~${usd(s.cost)} est.`),
          )}
          {cardRow(
            card('Sessions', fmt(s.sessions)),
            card('Longest session', data.meta.longestSessionMs ? duration(data.meta.longestSessionMs) : '–', 'all time'),
          )}
          {cardRow(
            card('Active days', `${s.activeDays}/${s.spanDays}`),
            card('Longest streak', `${s.longestStreak} days`),
          )}
          {cardRow(
            card('Most active day', s.mostActiveDay ? `${monthOf(s.mostActiveDay)} ${Number(s.mostActiveDay.slice(8, 10))}` : '–'),
            card('Current streak', `${s.currentStreak} days`),
          )}
          {cardRow(
            card('Messages', fmt(s.messages)),
            card('Peak hour', s.peakHour === null ? '–' : hourLabel(s.peakHour)),
          )}
          <Text dimColor wrap="wrap">
            {'  '}Input {fmt(s.tokens[0])} · Output {fmt(s.tokens[1])} · Cache read {fmt(s.tokens[2])} · Cache write{' '}
            {fmt(s.tokens[3])}
          </Text>
        </Box>
        {heatmap}
        {footer}
      </Box>
    )

    const barRoom = Math.max(6, cols - 4)
    const models = (
      <Box flexDirection="column" gap={1}>
        {s.models.length === 0 && <Text dimColor>No usage in this range.</Text>}
        {s.models.map(m => {
          const share = s.cost > 0 ? m.cost / s.cost : 0
          const n = Math.max(1, Math.round(share * barRoom))
          return (
            <Box flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold>{prettyModel(m.id)}</Text>
                <Text dimColor>
                  ~{usd(m.cost)} · {(share * 100).toFixed(1)}%
                </Text>
              </Box>
              <Text>
                <Text color={ACCENT}>{'█'.repeat(n)}</Text>
                <Text color={EMPTY}>{'░'.repeat(Math.max(0, barRoom - n))}</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {fmt(sum(m.tokens))} tokens
              </Text>
            </Box>
          )
        })}
        <Text dimColor>Share of estimated cost, {rangeName}.</Text>
        {footer}
      </Box>
    )

    // Analytics: usage history, top projects, cost, tools and replies over the range.
    const table = $.ui.resolve(e)
    const inner = Math.max(20, cols - 4)
    const chart = (key: string, sr: Series, kind: 'bars' | 'lines', value: (n: number) => string, alt: string) => {
      if (!sr.total) return <Text dimColor>No data in this range.</Text>
      if (e.surface === 'terminal' && 'Raster' in table) {
        const { Raster } = table
        return <Raster key={key} {...chartRaster(sr, inner)} />
      }
      if ('Svg' in table) {
        const { Svg } = table
        // A little wider than the slot, so the drawing fills it edge to edge.
        return <Svg key={key} source={chartSvg(sr, inner * 9.6, kind, value)} alt={alt} isInteractive />
      }
      return null
    }
    const row = (left: RenderChildren, right: RenderChildren) => (
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexShrink={1}>{left}</Box>
        <Box flexShrink={0}>{right}</Box>
      </Box>
    )
    const legend = (sr: Series, show: (k: SeriesKey) => string) => (
      <Box flexDirection="column">
        {sr.keys.map(k =>
          row(
            <Text wrap="truncate-end">
              <Text color={k.color}>●</Text> {k.label}
            </Text>,
            <Text dimColor>{show(k)}</Text>,
          ),
        )}
      </Box>
    )
    const shareOf = (part: number, whole: number) => {
      const v = whole ? (part / whole) * 100 : 0
      return v > 0 && v < 0.1 ? '<0.1%' : `${v.toFixed(1)}%`
    }
    const panel = (title: string, value: string, note: string, ...body: RenderChildren[]) => (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={1}>
        <Box flexDirection="column">
          {row(<Text bold>{title}</Text>, <Text bold>{value}</Text>)}
          <Text dimColor wrap="wrap">
            {note}
          </Text>
        </Box>
        {body}
      </Box>
    )
    const breakdownButton = (id: Breakdown, label: string) => (
      <Button
        key={`bd-${id}`}
        label={label}
        plain
        dimColor={breakdown !== id}
        onPress={() => void update($, breakdownAtom, () => id)}
      />
    )

    const history = series(
      data,
      range,
      breakdown === 'model'
        ? d => Object.fromEntries(Object.entries(d.m).map(([k, q]) => [k, sum(q)]))
        : d => scaled(d, breakdown === 'feature' ? d.f : breakdown === 'project' ? d.p : d.s),
      {
        label: breakdown === 'model' ? prettyModel : undefined,
        fixed: breakdown === 'feature' ? FEATURE_COLORS : undefined,
      },
    )
    const per = history.unit === 'day' ? 'a bar per day' : history.unit === 'week' ? 'a bar per week' : 'a bar per month'
    const costs = series(data, range, d => ({ 'Est. cost': d.c ?? 0 }))
    const tools = series(data, range, d => d.tl, { top: 4 })
    const replies = series(data, range, d => d.r, { top: 4, label: prettyModel })

    const projects = projectsIn(data, range)
    const projectTotal = projects.reduce((n, p) => n + p.tokens, 0)
    // A table like a billing page's: Project | Share | Tokens, a rule between rows, a row opens in place.
    const COL = 8
    const tableRow = (left: RenderChildren, mid: RenderChildren, right: RenderChildren) => (
      <Box flexDirection="row" gap={2}>
        <Box flexGrow={1} flexShrink={1}>
          {left}
        </Box>
        <Box width={COL} flexShrink={0} justifyContent="flex-end">
          {mid}
        </Box>
        <Box width={COL} flexShrink={0} justifyContent="flex-end">
          {right}
        </Box>
      </Box>
    )
    const rule = (key: string) => {
      if (e.surface !== 'terminal' && 'Svg' in table) {
        const { Svg } = table
        const w = Math.round(inner * 9.6)
        return (
          <Svg
            key={key}
            alt=""
            source={`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="1" viewBox="0 0 ${w} 1"><rect width="${w}" height="1" fill="#38383a"/></svg>`}
          />
        )
      }
      return (
        <Text key={key} dimColor>
          {'─'.repeat(inner)}
        </Text>
      )
    }
    const detail = (label: string, value: string) => (
      <Box flexDirection="row" gap={2}>
        <Box width={10} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text wrap="truncate-end">{value}</Text>
      </Box>
    )
    const projectTable = (
      <Box flexDirection="column">
        {tableRow(<Text dimColor>Project</Text>, <Text dimColor>Share</Text>, <Text dimColor>Tokens</Text>)}
        {projects.length === 0 && [rule('rule-empty'), <Text dimColor>No usage in this range.</Text>]}
        {projects.slice(0, projectRows).map(p => {
          const isOpen = openProject === p.name
          const info = projectInfo(p.chats)
          return (
            <Box flexDirection="column">
              {rule(`rule-${p.name}`)}
              {tableRow(
                <Button
                  key={`project-${p.name}`}
                  plain
                  label={`${isOpen ? '▾' : '▸'} ${truncate(p.name, Math.max(10, inner - 2 * COL - 6))}`}
                  onPress={() => void update($, openProjectAtom, cur => (cur === p.name ? null : p.name))}
                />,
                <Text>{shareOf(p.tokens, projectTotal)}</Text>,
                <Text>{fmt(p.tokens)}</Text>,
              )}
              {isOpen && (
                <Box flexDirection="column" paddingLeft={2} marginTop={1} marginBottom={1} gap={1}>
                  {p.name === 'Older logs' ? (
                    <Text dimColor wrap="wrap">
                      Days whose transcripts are gone: only their totals are kept.
                    </Text>
                  ) : info.chats === 0 ? (
                    <Text dimColor>No chat details kept for this range.</Text>
                  ) : (
                    <Box flexDirection="column">
                      {detail('Chats', info.subagents ? `${info.chats} · ${commas(info.subagents)} subagents` : `${info.chats}`)}
                      {info.model && detail('Model', prettyModel(info.model))}
                      {info.surface && detail('Surface', info.surface)}
                      {info.last && detail('Last chat', shortDate(info.last))}
                    </Box>
                  )}
                  {info.chats > 0 && (
                    <Box flexDirection="column">
                      {p.chats.slice(0, 8).map(c =>
                        tableRow(
                          <Text wrap="truncate-end">{c.title}</Text>,
                          <Text dimColor>{shortDate(c.day)}</Text>,
                          <Text dimColor>{fmt(c.tokens)}</Text>,
                        ),
                      )}
                      {p.chats.length > 8 && <Text dimColor>+{p.chats.length - 8} more chats</Text>}
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
        {projects.length > projectRows && [
          rule('rule-more'),
          <Button
            key="projects-more"
            label={`Show ${Math.min(10, projects.length - projectRows)} more`}
            plain
            dimColor
            onPress={() => void update($, projectRowsAtom, n => n + 10)}
          />,
        ]}
      </Box>
    )

    const analytics = (
      <Box flexDirection="column" gap={1}>
        {panel('Top projects', `${projects.length}`, 'Click a project to see its chats.', projectTable)}
        {panel(
          'Usage history',
          `${fmt(history.total)} tokens`,
          `${rangeLabel(data, range)} · ${per}`,
          <Box flexDirection="row" gap={2}>
            {breakdownButton('feature', 'Feature')}
            {breakdownButton('model', 'Model')}
            {breakdownButton('project', 'Project')}
            {breakdownButton('surface', 'Surface')}
          </Box>,
          chart('history', history, 'bars', fmt, 'Tokens over time, stacked by ' + breakdown),
          legend(history, k => `${fmt(k.total)} · ${shareOf(k.total, history.total)}`),
        )}
        {panel(
          'Cost history',
          `~${usd(costs.total)}`,
          'Estimated at API list prices.',
          chart('cost', costs, 'bars', usd, 'Estimated cost over time'),
        )}
        {panel(
          'Tool activity',
          `${commas(tools.total)} calls`,
          'MCP tools grouped by server.',
          chart('tools', tools, e.surface === 'terminal' ? 'bars' : 'lines', fmt, 'Tool calls over time'),
          legend(tools, k => commas(k.total)),
        )}
        {panel(
          'Replies',
          commas(replies.total),
          "Claude's replies by model.",
          chart('replies', replies, e.surface === 'terminal' ? 'bars' : 'lines', fmt, 'Replies over time by model'),
          legend(replies, k => commas(k.total)),
        )}
      </Box>
    )

    const time = new Date(data.updatedAt).toTimeString().slice(0, 5)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={1}>
            {tabButton('overview', 'Overview')}
            {tabButton('models', 'Models')}
            {tabButton('analytics', 'Analytics')}
          </Box>
          <Box flexDirection="row" gap={1}>
            {rangeButton('all', 'All')}
            {rangeButton('30d', '30d')}
            {rangeButton('7d', '7d')}
          </Box>
        </Box>
        {tab === 'overview' ? overview : tab === 'models' ? models : analytics}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text dimColor>{error ? `Refresh failed: ${error}` : `Updated ${time}`}</Text>
          {refreshButton}
        </Box>
      </Box>
    )
  })
}
