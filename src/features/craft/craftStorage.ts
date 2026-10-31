import { CRAFT_MODULES, craftTemplates, type CraftCourse, type CraftModule } from '../waterSimulation/garden/craft'
import { CHALLENGES, CHAPTERS, type Challenge } from '../waterSimulation/garden/challenges'
import { CAMPAIGN_KEY, nextStageIndex, stageOpen } from './campaignIndex'

export const CRAFT_KEY = 'mazecraft.craft.v1'
export const CHALLENGE_KEY = CAMPAIGN_KEY
export interface ChallengeSave {
  stars: Record<string, number>
  drafts: Record<string, CraftModule[]>
  /** Fastest arrival (s) per cleared stage. */
  best: Record<string, number>
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Stored data is user-controlled and may be from an interrupted/older save. */
export function validCraftModule(value: unknown): value is CraftModule {
  return record(value) && typeof value.id === 'string' && value.id.length > 0
    && CRAFT_MODULES.some(info => info.kind === value.kind)
    && ['straight', 'left', 'right'].includes(String(value.turn))
    && ['plain', 'tipper', 'wheel', 'chain'].includes(String(value.exit))
    && ['small', 'medium', 'large'].includes(String(value.size))
    && typeof value.seed === 'number' && Number.isFinite(value.seed)
    && typeof value.wheels === 'boolean'
}

/** The free-build course a first visit opens on: a gentle beginner garden. */
export const firstCourse = (): CraftCourse => craftTemplates()[0].course

export function readCourse(key = CRAFT_KEY, fallback = firstCourse()): CraftCourse {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (record(stored) && stored.version === 1 && Array.isArray(stored.modules)
      && stored.modules.every(validCraftModule)) {
      return { version: 1, name: typeof stored.name === 'string' ? stored.name : '나의 물길',
        source: Math.max(2.5, Math.min(6.5, Number(stored.source) || 4.3)), modules: stored.modules.slice(0, 12) }
    }
  } catch { /* Storage can be disabled or damaged. */ }
  return fallback
}

export function readChallengeSave(key = CHALLENGE_KEY): ChallengeSave {
  const save: ChallengeSave = { stars: {}, drafts: {}, best: {} }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!record(stored)) return save
    for (const stage of CHALLENGES) {
      const stars = record(stored.stars) ? stored.stars[stage.id] : undefined
      if (typeof stars === 'number' && Number.isInteger(stars) && stars >= 0 && stars <= 3) save.stars[stage.id] = stars
      const draft = record(stored.drafts) ? stored.drafts[stage.id] : undefined
      if (Array.isArray(draft)) save.drafts[stage.id] = draft.filter(validCraftModule).slice(0, 12)
      const best = record(stored.best) ? stored.best[stage.id] : undefined
      if (typeof best === 'number' && Number.isFinite(best) && best > 0) save.best[stage.id] = best
    }
  } catch { /* Storage can be disabled or damaged. */ }
  return save
}

export function writeChallengeSave(save: ChallengeSave, key = CHALLENGE_KEY): void {
  try { localStorage.setItem(key, JSON.stringify(save)) } catch { /* Optional persistence. */ }
}

/**
 * A stage is open when it is the first, when the stage before it has a star,
 * or when it was cleared before (so stages added to the campaign later never
 * lock what a player already finished).
 */
export function isStageOpen(save: Pick<ChallengeSave, 'stars'>, index: number): boolean {
  return stageOpen(save.stars, index)
}

/** Resume the earliest open unfinished stage, or the last stage once all are cleared. */
export function nextChallengeId(save: Pick<ChallengeSave, 'stars'>): string {
  return CHALLENGES[nextStageIndex(save.stars)].id
}

export interface CampaignProgress {
  cleared: number
  total: number
  stars: number
  maxStars: number
  /** The stage to play next (see nextChallengeId). */
  next: Challenge
  /** Every stage has at least one star. */
  complete: boolean
}

export function campaignProgress(save: Pick<ChallengeSave, 'stars'>): CampaignProgress {
  const cleared = CHALLENGES.filter(stage => (save.stars[stage.id] ?? 0) > 0).length
  const stars = CHALLENGES.reduce((sum, stage) => sum + (save.stars[stage.id] ?? 0), 0)
  const nextId = nextChallengeId(save)
  return {
    cleared, total: CHALLENGES.length, stars, maxStars: CHALLENGES.length * 3,
    next: CHALLENGES.find(stage => stage.id === nextId)!, complete: cleared === CHALLENGES.length,
  }
}

/** Stars earned and available in one chapter. */
export function chapterStars(save: Pick<ChallengeSave, 'stars'>, chapter: number): { stars: number; max: number; cleared: boolean } {
  const stages = CHALLENGES.filter(stage => stage.chapter === chapter)
  return {
    stars: stages.reduce((sum, stage) => sum + (save.stars[stage.id] ?? 0), 0),
    max: stages.length * 3,
    cleared: stages.every(stage => (save.stars[stage.id] ?? 0) > 0),
  }
}

/** The first stage that still has stars to earn, for a "collect the rest" button. */
export function nextUnstarredStage(save: Pick<ChallengeSave, 'stars'>): Challenge | null {
  return CHALLENGES.find((stage, k) => isStageOpen(save, k) && (save.stars[stage.id] ?? 0) < 3) ?? null
}

export const CHAPTER_COUNT = CHAPTERS.length
