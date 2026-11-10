import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  chartRaster,
  chartSvg,
  chatsIn,
  projectInfo,
  projectsIn,
  compareLabel,
  heatmapCells,
  heatmapRaster,
  heatmapSvg,
  monthLabels,
  pace,
  pct,
  prettyModel,
  scaled,
  series,
  summarize,
} from '../hooks/register'
import type { Chat, Day, Quad, Usage } from '../types'

const PANE = {
  plugin: 'token-usage',
  component: 'Pane',
  requestId: 'token-usage',
  props: {
    title: 'Token usage',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const day = (t: Quad, msgs: number, sess: number, hour: string, model: string, c: number): Day => ({
  t, msgs, sess, h: { [hour]: sess }, m: { [model]: t }, c, mc: { [model]: c },
})

// 2026-11-10 is a Tuesday.
const DAYS: Record<string, Day> = {
  '2026-11-10': {
    ...day([0, 500_000, 1_000_000, 0], 10, 1, '22', 'claude-opus-5-5', 10),
    f: { Chats: 3, Subagents: 1 },
    p: { 'my-app': 1 },
    s: { 'Desktop app': 1 },
    tl: { Bash: 5, Read: 2 },
    r: { 'claude-opus-5-5': 4 },
  },
  '2026-11-09': day([0, 100_000, 0, 0], 5, 2, '22', 'claude-opus-5-5', 2),
  '2026-11-08': day([0, 100_000, 2_500_000, 0], 3, 1, '9', 'claude-sonnet-5-5', 5),
  '2026-10-01': day([0, 1_000_000, 0, 0], 4, 1, '9', 'claude-sonnet-5-5', 20),
}
const META = {
  firstDay: '2026-10-01',
  firstSessionAt: '2026-10-01T00:00:00',
  longestSessionMs: ((6 * 24 + 3) * 60 + 7) * 60_000,
  hours: { '22': 5, '9': 1 },
  statsThrough: '2026-11-09',
}
const chat = (id: string, title: string, d: string, tokens: number): Chat => ({
  id, title, project: 'my-app', surface: 'Desktop app', day: d, model: 'claude-opus-5-5',
  tokens, cost: 3, subagents: 2, msgs: 40,
})
const CHATS = [chat('a', 'Add dark mode toggle', '2026-11-10', 1_200_000), chat('b', 'Old audit', '2026-10-01', 900_000)]
const DATA: Usage = { today: '2026-11-10', meta: META, days: DAYS, chats: CHATS, updatedAt: 0 }
const OUTPUT = JSON.stringify({ today: DATA.today, meta: META, days: DAYS, chats: CHATS })
const ran = (exitCode: number, stdout: string, stderr: string) => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

test('model ids read as names', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(prettyModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(prettyModel('claude-opus-4-20250514')).toBe('Opus 4')
})

test('summary over each range', () => {
  const all = summarize(DATA, 'all')
  expect(all.sessions).toBe(5)
  expect(all.activeDays).toBe(4)
  expect(all.spanDays).toBe(41)
  expect(all.mostActiveDay).toBe('2026-11-10')
  expect(all.currentStreak).toBe(3)
  expect(all.longestStreak).toBe(3)
  expect(all.peakHour).toBe(22)
  expect(all.cost).toBe(37)
  expect(all.models[0]?.id).toBe('claude-sonnet-5-5')
  const week = summarize(DATA, '7d')
  expect(week.activeDays).toBe(3)
  expect(week.messages).toBe(10 + 5 + 3)
  expect(week.sessions).toBe(4)
  // the favorite model has the most tokens
  expect(week.models[0]?.id).toBe('claude-sonnet-5-5')
})

test('today against the daily average, and the month at its pace', () => {
  const p = pace(DATA)
  // Nov 8 and 9 are the active days before today: (2.6M + 0.1M) / 2
  expect(p.dailyAverage).toBe(1_350_000)
  expect(p.ratio?.toFixed(2)).toBe('1.11')
  expect(p.month.cost).toBe(17)
  // ten days into a 30-day month
  expect(p.projected.tokens).toBe(12_600_000)
  expect(p.projected.cost).toBe(51)
  expect(compareLabel(5)).toBe('↑ 5.0× your daily average')
  expect(compareLabel(0.5)).toBe('↓ 0.5× your daily average')
  expect(compareLabel(1)).toBe('about your daily average')
  expect(compareLabel(null)).toBe('no recent days to compare')
})

test('the heatmap ends on today, labels months and every day', () => {
  const cells = heatmapCells(DATA, 4)
  const last = cells[cells.length - 1]
  expect(last?.date).toBe('2026-11-10')
  expect(last?.row).toBe(2)
  expect(last?.col).toBe(3)
  expect(cells[0]?.date).toBe('2026-10-18')
  // Oct holds two columns only, too few for its name
  expect(monthLabels(cells)).toEqual([{ col: 2, label: 'Nov' }])
  const svg = heatmapSvg(DATA, 4)
  expect(svg).toContain('Tue, Nov 10, 2026 &#183; 1.5M tokens &#183; ~$10.00')
  expect(svg).toContain('Sun, Nov 1, 2026 &#183; no usage')
  expect(svg).toContain('class="today"')
  expect(svg).toContain('>Less<')
  expect(svg).toContain('>Mon<')
  const raster = heatmapRaster(DATA, 4)
  expect(raster.columns).toBe(11)
  expect(raster.rows).toBe(8)
  expect(raster.cells.length).toBe(Math.ceil((11 * 8 * 12) / 3) * 4)
})

test('breakdowns scale to the day and bucket by the range', () => {
  const today = DAYS['2026-11-10']!
  // 1.5M tokens split 3:1 between chats and subagents
  expect(scaled(today, today.f)).toEqual({ Chats: 1_125_000, Subagents: 375_000 })
  expect(scaled(DAYS['2026-10-01']!, undefined)).toEqual({ 'Older logs': 1_000_000 })

  const week = series(DATA, '7d', d => scaled(d, d.f))
  expect(week.unit).toBe('day')
  expect(week.buckets.length).toBe(7)
  expect(week.keys.map(k => k.key)).toEqual(['Chats', 'Subagents', 'Older logs'])
  expect(week.total).toBe(1_500_000 + 100_000 + 2_600_000)

  const all = series(DATA, 'all', d => Object.fromEntries(Object.entries(d.m).map(([k, q]) => [k, q[0] + q[1] + q[2] + q[3]])))
  expect(all.unit).toBe('week')
  expect(all.buckets[0]?.start).toBe('2026-10-01')
  expect(all.buckets[all.buckets.length - 1]?.end).toBe('2026-11-10')
  expect(all.total).toBe(5_200_000)

  // past the top keys, the rest fold into Other
  const tools = series(DATA, '7d', d => d.tl, { top: 1 })
  expect(tools.keys.map(k => k.key)).toEqual(['Bash', 'Read'])
  const folded = series(
    { ...DATA, days: { '2026-11-10': { ...today, tl: { A: 9, B: 5, C: 2, D: 1 } } } },
    '7d',
    d => d.tl,
    { top: 2 },
  )
  expect(folded.keys.map(k => `${k.key}:${k.total}`)).toEqual(['A:9', 'B:5', 'Other:3'])

  const svg = chartSvg(week, 400, 'bars', n => String(n))
  expect(svg).toContain('Nov 10 &#183; 1500000 &#183; Chats 75%, Subagents 25%')
  // the latest bar is shown until another is hovered
  expect(svg).toContain('class="now"')
  const lines = chartSvg(tools, 400, 'lines', n => String(n))
  expect(lines).toContain('<polyline')
  const raster = chartRaster(week, 30)
  expect(raster.columns).toBe(28)
  expect(raster.rows).toBe(9)
})

test('top chats keep to the range', () => {
  expect(chatsIn(DATA, '7d').map(c => c.id)).toEqual(['a'])
  expect(chatsIn(DATA, 'all').map(c => c.id)).toEqual(['a', 'b'])
  const projects = projectsIn(DATA, 'all')
  expect(projects.map(p => [p.name, p.tokens, p.chats.length])).toEqual([
    ['Older logs', 3_700_000, 0],
    ['my-app', 1_500_000, 2],
  ])
  expect(projectsIn(DATA, '7d')[1]?.chats.map(c => c.id)).toEqual(['a'])
  expect(projectInfo(projects[1]!.chats)).toEqual({
    chats: 2, subagents: 4, model: 'claude-opus-5-5', surface: 'Desktop app', last: '2026-11-10',
  })
  expect(projectInfo([]).model).toBeUndefined()
  expect(pct(0.0331)).toBe('3.31%')
  expect(pct(0.00001)).toBe('<0.01%')
})

const start = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], output: ReturnType<typeof ran>) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'token-usage' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => output)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)
}

test('the overview leads with total tokens, cost and pace', async ($, on) => {
  await start($, on, ran(0, OUTPUT, ''))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^1\.5M · / }))?.text).toBe('1.5M · ~$10.00')
    expect(await ui.find({ type: 'Text', text: /^↑ 1\.1× your daily average$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^4\.2M · / }))?.text).toBe('4.2M · ~$17.00')
    expect(await ui.find({ type: 'Text', text: /^on pace for 12\.6M · ~\$51\.00$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cache reads|Counted as/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^10 PM$/ }))?.text).toBe('10 PM')
    expect(await ui.find({ type: 'Text', text: /^4\/41$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^6d 3h 7m$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Nov 10$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^3 days$/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-models' })
  expect((await ui.find({ type: 'Text', text: /^Sonnet 5\.5$/ }))?.text).toBe('Sonnet 5.5')
  await ui.press({ key: 'range-7d' })
  expect((await ui.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.text).toBe('Opus 5.5')
  await ui.unmount()
})

test('desktop draws an Svg heatmap, the terminal a Raster with a key', async ($, on) => {
  await start($, on, ran(0, OUTPUT, ''))
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Raster' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^Less/ })).toBeDefined()
  await term.unmount()
})

test('the analytics tab draws its charts and opens a project', async ($, on) => {
  await start($, on, ran(0, OUTPUT, ''))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-analytics' })
    expect(await ui.find({ type: 'Text', text: /^Usage history$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Top projects$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^~\$37\.00$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^7 calls$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Replies$/ })).toBeDefined()
    expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Add dark mode toggle$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Share$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^28\.8%$/ })).toBeDefined()
    await ui.press({ key: 'project-my-app' })
    expect(await ui.find({ type: 'Text', text: /^Add dark mode toggle$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2 · 4 subagents$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Desktop app$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Old audit$/ })).toBeDefined()
    await ui.press({ key: 'project-my-app' })
    expect(await ui.find({ type: 'Text', text: /^Old audit$/ })).toBeUndefined()
    await ui.press({ key: 'tab-overview' })
    await ui.unmount()
  }
})

test('a failing aggregator shows the error, not a crash', async ($, on) => {
  await start($, on, ran(1, '', 'boom'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /boom/ }))?.text).toBe('Could not read usage: boom')
  await ui.unmount()
})
