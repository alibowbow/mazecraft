import { objectOf, type CraftCourse } from '../waterSimulation/garden/craft'
import type { GardenProgress } from '../waterSimulation/garden/progress'
import {
  CHALLENGES, goalProgress, goalText, isCourseGoal,
  type Challenge, type GoalState,
} from '../waterSimulation/garden/challenges'
import { chapterStars, type ChallengeSave } from './craftStorage'

/** The first stage teaches the loop in three steps: add a device, pour, watch it arrive. */
export type CoachStep = 'add' | 'pour' | 'watch'

export function coachStep(stage: Challenge, course: CraftCourse, state: {
  /** The stage was already cleared at least once. */
  cleared: boolean
  /** The scene for the current course is ready to run. */
  ready: boolean
  /** Water has started flowing in this run. */
  started: boolean
  /** The briefing card is still open. */
  briefing: boolean
}): CoachStep | null {
  if (stage.id !== CHALLENGES[0].id || state.cleared || state.briefing) return null
  if (course.modules.length <= stage.locked.length) return 'add'
  if (!state.ready) return null
  return state.started ? 'watch' : 'pour'
}

/**
 * Why a run is not clearing, in words a player can act on. Course rules are
 * reported once the water has started; a missed arrival once time runs out.
 */
export function missReason(stage: Challenge, course: CraftCourse, goals: GoalState[], progress: GardenProgress | null, time: number): string | null {
  if (time <= 0) return null
  for (let k = 0; k < stage.goals.length; k++) {
    const goal = stage.goals[k]
    if (goals[k] !== 'failed' || !isCourseGoal(goal)) continue
    const now = goalProgress(goal, course, progress, time)
    const text = goalText(goal)
    // ‘장치 3개 이상’을, ‘양수 장치 없이’를: the particle follows the goal's last syllable.
    const particle = objectOf(text).slice(text.length)
    return `목표 ‘${text}’${particle} 아직 채우지 못했어요${now ? ` (${now})` : ''}. 물길을 고친 뒤 다시 부어 보세요.`
  }
  const reach = stage.goals.findIndex(goal => goal.kind === 'reach')
  if (reach >= 0 && goals[reach] === 'failed') {
    const goal = stage.goals[reach] as { kind: 'reach'; within: number }
    return progress?.arrival != null
      ? `종착 연못까지 ${progress.arrival.toFixed(0)}초 걸렸어요. ${goal.within}초 안에 닿아야 해요.`
      : `${goal.within}초 안에 종착 연못에 닿지 못했어요.`
  }
  return null
}

/** The chapter a clear just finished for the first time, if any. */
export function chapterCompletedBy(stage: Challenge, before: Pick<ChallengeSave, 'stars'>, after: Pick<ChallengeSave, 'stars'>): number | null {
  return !chapterStars(before, stage.chapter).cleared && chapterStars(after, stage.chapter).cleared ? stage.chapter : null
}

/** Whether this clear finished the whole campaign for the first time. */
export function campaignCompletedBy(before: Pick<ChallengeSave, 'stars'>, after: Pick<ChallengeSave, 'stars'>): boolean {
  const done = (save: Pick<ChallengeSave, 'stars'>) => CHALLENGES.every(stage => (save.stars[stage.id] ?? 0) > 0)
  return !done(before) && done(after)
}
