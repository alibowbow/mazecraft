/**
 * The campaign's stage list without the stage data, small enough for the
 * home screen's progress card. challenges.test.ts keeps it in step with
 * CHALLENGES (ids, names, chapters and order).
 */
export const CAMPAIGN_KEY = 'mazecraft.challenges.v1'

export const CHAPTER_NAMES = ['샘과 연못', '물레와 사이펀', '끌어올리는 힘', '다리와 물살'] as const

export const STAGE_INDEX: ReadonlyArray<{ id: string; name: string; chapter: number }> = [
  { id: 'first-drop', name: '첫 물길', chapter: 0 },
  { id: 'bamboo-knock', name: '대나무의 딱 소리', chapter: 0 },
  { id: 'maze-path', name: '미로 속 물길', chapter: 0 },
  { id: 'rain-chain', name: '빗물 사슬', chapter: 0 },
  { id: 'stepping-ponds', name: '징검다리 연못', chapter: 0 },
  { id: 'water-wheels', name: '물레바퀴 마을', chapter: 1 },
  { id: 'zen-garden', name: '고요한 정원', chapter: 1 },
  { id: 'three-voices', name: '세 가지 소리', chapter: 1 },
  { id: 'siphon-burst', name: '한꺼번에 쏟아라', chapter: 1 },
  { id: 'siphon-bamboo', name: '쏟아지면 우는 대나무', chapter: 1 },
  { id: 'low-spring', name: '낮은 샘', chapter: 2 },
  { id: 'noria-lift', name: '물레방아의 힘', chapter: 2 },
  { id: 'maze-trilogy', name: '셋째 미로까지', chapter: 2 },
  { id: 'spiral-tower', name: '나선 탑', chapter: 2 },
  { id: 'siphon-tower', name: '높은 곳의 사이펀', chapter: 2 },
  { id: 'zigzag-run', name: '굽이치는 물살', chapter: 3 },
  { id: 'few-devices', name: '적게, 멀리', chapter: 3 },
  { id: 'no-pumps', name: '펌프 없이 멀리', chapter: 3 },
  { id: 'quick-flow', name: '서둘러, 종착 연못으로', chapter: 3 },
  { id: 'grand-garden', name: '물의 대정원', chapter: 3 },
]

type Stars = Readonly<Record<string, number>>

/**
 * A stage is open when it is the first, when the stage before it has a star,
 * or when it was cleared before (so stages added to the campaign later never
 * lock what a player already finished).
 */
export function stageOpen(stars: Stars, index: number): boolean {
  if (index <= 0) return true
  const stage = STAGE_INDEX[index], previous = STAGE_INDEX[index - 1]
  return Boolean(stage && ((stars[stage.id] ?? 0) > 0 || (stars[previous.id] ?? 0) > 0))
}

/** The earliest open unfinished stage, or the last stage once all are cleared. */
export function nextStageIndex(stars: Stars): number {
  const index = STAGE_INDEX.findIndex((stage, k) => stageOpen(stars, k) && !((stars[stage.id] ?? 0) > 0))
  return index >= 0 ? index : STAGE_INDEX.length - 1
}

export interface CampaignSummary {
  cleared: number
  total: number
  stars: number
  maxStars: number
  /** 1-based number, name and chapter of the stage to play next. */
  next: { number: number; name: string; chapter: number }
  complete: boolean
}

/** Stars as saved, keeping only whole numbers from 0 to 3 for known stages. */
export function readSavedStars(): Record<string, number> {
  const stars: Record<string, number> = {}
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CAMPAIGN_KEY) ?? 'null')
    const saved = stored && typeof stored === 'object' ? (stored as { stars?: unknown }).stars : undefined
    if (!saved || typeof saved !== 'object') return stars
    for (const { id } of STAGE_INDEX) {
      const count = (saved as Record<string, unknown>)[id]
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 3) stars[id] = count
    }
  } catch { /* Storage can be disabled or damaged. */ }
  return stars
}

export function summarizeCampaign(stars: Stars = readSavedStars()): CampaignSummary {
  const cleared = STAGE_INDEX.filter(stage => (stars[stage.id] ?? 0) > 0).length
  const total = STAGE_INDEX.length
  const index = nextStageIndex(stars)
  return {
    cleared, total,
    stars: STAGE_INDEX.reduce((sum, stage) => sum + (stars[stage.id] ?? 0), 0),
    maxStars: total * 3,
    next: { number: index + 1, name: STAGE_INDEX[index].name, chapter: STAGE_INDEX[index].chapter },
    complete: cleared === total,
  }
}
