import { CRAFT_MODULES, craftTemplates, type CraftCourse, type CraftModule } from '../waterSimulation/garden/craft'
import { CHALLENGES } from '../waterSimulation/garden/challenges'

export const CRAFT_KEY = 'mazecraft.craft.v1'
export const CHALLENGE_KEY = 'mazecraft.challenges.v1'
export interface ChallengeSave { stars: Record<string, number>; drafts: Record<string, CraftModule[]> }

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

export function readCourse(key = CRAFT_KEY, fallback = craftTemplates()[1].course): CraftCourse {
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
  const save: ChallengeSave = { stars: {}, drafts: {} }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!record(stored)) return save
    for (const stage of CHALLENGES) {
      const stars = record(stored.stars) ? stored.stars[stage.id] : undefined
      if (typeof stars === 'number' && Number.isInteger(stars) && stars >= 0 && stars <= 3) save.stars[stage.id] = stars
      const draft = record(stored.drafts) ? stored.drafts[stage.id] : undefined
      if (Array.isArray(draft)) save.drafts[stage.id] = draft.filter(validCraftModule).slice(0, 12)
    }
  } catch { /* Storage can be disabled or damaged. */ }
  return save
}

export function writeChallengeSave(save: ChallengeSave, key = CHALLENGE_KEY): void {
  try { localStorage.setItem(key, JSON.stringify(save)) } catch { /* Optional persistence. */ }
}

/** Resume the earliest unlocked unfinished stage, or the last completed one. */
export function nextChallengeId(save: ChallengeSave): string {
  return CHALLENGES.find((stage, k) => (k === 0 || (save.stars[CHALLENGES[k - 1].id] ?? 0) > 0)
    && !(save.stars[stage.id] > 0))?.id ?? CHALLENGES[CHALLENGES.length - 1].id
}
