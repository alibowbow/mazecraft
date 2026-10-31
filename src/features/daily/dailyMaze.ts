import { createDefaultProject, type DifficultyLevel, type MazeProject } from '../../core/maze'
import { SHAPE_LABELS, type BuiltInShape } from '../../core/masks/types'
import { regenerateProjectSync } from '../../app/projectFactory'

/**
 * 오늘의 미로: one maze per calendar day, the same for everyone on that day.
 * Its shape, size and colours follow from the date alone, so nothing is
 * downloaded and the maze is rebuilt identically on every visit.
 */
export const DAILY_KEY = 'mazecraft.daily.v1'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const

/** The week climbs from gentle Monday to the long Sunday maze. Indexed by Date.getDay(). */
const WEEK: ReadonlyArray<{ difficulty: DifficultyLevel; size: number; label: string }> = [
  { difficulty: 'expert', size: 30, label: '아주 어려움' },
  { difficulty: 'easy', size: 18, label: '쉬움' },
  { difficulty: 'easy', size: 20, label: '쉬움' },
  { difficulty: 'normal', size: 22, label: '보통' },
  { difficulty: 'normal', size: 24, label: '보통' },
  { difficulty: 'hard', size: 26, label: '어려움' },
  { difficulty: 'hard', size: 28, label: '어려움' },
]

const SHAPES: readonly BuiltInShape[] = [
  'heart', 'star', 'flower', 'cloud', 'hexagon', 'crown', 'circle',
  'tree', 'diamond', 'house', 'crescent', 'speech-bubble', 'puzzle', 'rounded-rectangle',
]

const PALETTES = [
  { name: '바다', wall: '#1f4e5f', path: '#f3fafa', start: '#14937a', end: '#e0663a', accent: '#2a8f96' },
  { name: '숲', wall: '#2f4b36', path: '#f6f8f0', start: '#3c9a5f', end: '#d9822b', accent: '#5a9a3c' },
  { name: '노을', wall: '#6b3a2e', path: '#fff7ef', start: '#d9822b', end: '#b8325a', accent: '#e0663a' },
  { name: '밤하늘', wall: '#2b2f5a', path: '#f5f6ff', start: '#4b7bd9', end: '#d94b8a', accent: '#6c63c7' },
  { name: '도자기', wall: '#283d40', path: '#faf9f5', start: '#267e87', end: '#bb956c', accent: '#267e87' },
  { name: '벚꽃', wall: '#7a3b55', path: '#fff6f9', start: '#d9608a', end: '#4e8f6a', accent: '#c4467a' },
  { name: '모래', wall: '#5c4a2e', path: '#fffaf0', start: '#b5832a', end: '#2f7f87', accent: '#c4952e' },
] as const

const pad = (value: number) => String(value).padStart(2, '0')

/** The visitor's calendar date as YYYY-MM-DD. */
export function dailyKey(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

/** Days since 2026-01-01, so consecutive days get consecutive shapes and colours. */
function dayNumber(key: string): number {
  const date = parseKey(key)
  return Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(2026, 0, 1)) / 86_400_000)
}

const wrap = (value: number, length: number) => ((value % length) + length) % length

export interface DailyInfo {
  key: string
  /** e.g. 10월 31일 토요일 */
  dateLabel: string
  /** e.g. 토요일; the weekday sets the difficulty. */
  weekday: string
  shape: BuiltInShape
  shapeLabel: string
  difficultyLabel: string
  paletteName: string
}

export function dailyInfo(key = dailyKey()): DailyInfo {
  const date = parseKey(key)
  const day = dayNumber(key)
  const shape = SHAPES[wrap(day, SHAPES.length)]
  return {
    key,
    dateLabel: `${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAYS[date.getDay()]}요일`,
    weekday: `${WEEKDAYS[date.getDay()]}요일`,
    shape,
    shapeLabel: SHAPE_LABELS[shape],
    difficultyLabel: WEEK[date.getDay()].label,
    paletteName: PALETTES[wrap(day, PALETTES.length)].name,
  }
}

/** Today's maze as a play-only project; its id keeps one personal best per day. */
export function createDailyMaze(key = dailyKey()): MazeProject {
  const date = parseKey(key)
  const day = dayNumber(key)
  const info = dailyInfo(key)
  const week = WEEK[date.getDay()]
  const palette = PALETTES[wrap(day, PALETTES.length)]
  const base = createDefaultProject({
    id: `daily-${key}`,
    title: `오늘의 미로 · ${date.getMonth() + 1}월 ${date.getDate()}일`,
    seed: `daily-${key}`,
    difficulty: week.difficulty,
    grid: { rows: week.size, cols: week.size, minimumCellPixels: 10 },
    shape: { kind: 'basic', name: info.shape, inset: 0 },
    visualTheme: {
      wallColor: palette.wall, pathColor: palette.path, startColor: palette.start, endColor: palette.end,
      accentColor: palette.accent, wallWidth: 2, cornerRadius: 0,
    },
    background: { kind: 'solid', color: palette.path },
    gameRules: { mode: 'classic', timeLimitSeconds: null, allowedHints: 3, showDpad: true, soundEnabled: true, ghostAllowed: false },
  })
  return regenerateProjectSync(base)
}

export interface DailyRecord {
  /** Fastest finish (ms) per day played. */
  best: Record<string, number>
}

/** A stored daily record, or null when the text is not one. Invalid days are dropped. */
export function parseDailyRecord(text: string | null): DailyRecord | null {
  if (text === null) return null
  try {
    const stored: unknown = JSON.parse(text)
    const best = stored && typeof stored === 'object' ? (stored as { best?: unknown }).best : undefined
    if (!best || typeof best !== 'object' || Array.isArray(best)) return null
    const record: DailyRecord = { best: {} }
    for (const [key, value] of Object.entries(best as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && typeof value === 'number' && Number.isFinite(value) && value > 0) record.best[key] = value
    }
    return record
  } catch {
    return null
  }
}

export function readDailyRecord(): DailyRecord {
  try {
    return parseDailyRecord(localStorage.getItem(DAILY_KEY)) ?? { best: {} }
  } catch {
    return { best: {} } // Storage can be disabled.
  }
}

/** Days of finishes kept; enough for a year-long streak while the record stays a few KB. */
const KEPT_DAYS = 400

function keepRecentDays(best: Record<string, number>): DailyRecord {
  // ISO dates sort by time, so the oldest days are dropped first.
  const days = Object.keys(best).sort().slice(-KEPT_DAYS)
  return { best: Object.fromEntries(days.map((day) => [day, best[day]])) }
}

/** Keep the faster of the saved and the new finish for that day. */
export function recordDailyFinish(key: string, elapsedMs: number, record = readDailyRecord()): DailyRecord {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return record
  const next = keepRecentDays({ ...record.best, [key]: Math.min(elapsedMs, record.best[key] ?? Infinity) })
  try { localStorage.setItem(DAILY_KEY, JSON.stringify(next)) } catch { /* Optional record. */ }
  return next
}

/** The days of both records, with the faster finish of a day played on both (backup restore). */
export function mergeDailyRecords(local: DailyRecord | null, incoming: DailyRecord): DailyRecord {
  const best = { ...local?.best }
  for (const [day, value] of Object.entries(incoming.best)) best[day] = Math.min(value, best[day] ?? Infinity)
  return keepRecentDays(best)
}

/** The lines a player sends a friend after a finish. */
export function dailyShareText(info: DailyInfo, result: { time: string; hints: number; streak: number }): string {
  const streak = result.streak > 1 ? ` · 연속 ${result.streak}일` : ''
  return `MazeCraft 오늘의 미로 · ${info.dateLabel}\n${info.shapeLabel} 모양 · ${info.difficultyLabel} · ${result.time} 완주 · 힌트 ${result.hints}회${streak}`
}

/** The address of today's maze, from whichever screen is open. */
export function dailyLink(href = typeof location === 'undefined' ? 'https://localhost/' : location.href): string {
  return `${href.split('#')[0]}#/daily`
}

/** Days in a row with a finish, ending today (or yesterday, while today is still open). */
export function dailyStreak(record: DailyRecord, today = dailyKey()): number {
  const date = parseKey(today)
  if (!record.best[today]) date.setDate(date.getDate() - 1)
  let streak = 0
  while (record.best[dailyKey(date)]) {
    streak++
    date.setDate(date.getDate() - 1)
  }
  return streak
}
