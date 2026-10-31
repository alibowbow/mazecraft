import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHALLENGES } from '../waterSimulation/garden/challenges'
import { craftTemplates } from '../waterSimulation/garden/craft'
import {
  campaignProgress, chapterStars, CRAFT_KEY, CHALLENGE_KEY, isStageOpen, nextChallengeId, nextUnstarredStage, readChallengeSave, readCourse,
} from './craftStorage'
import { campaignCompletedBy, chapterCompletedBy, coachStep, missReason } from './challengeFlow'
import { challengeCourse, judgeGoals } from '../waterSimulation/garden/challenges'

beforeEach(() => localStorage.clear())

const allStars = (count = 3) => Object.fromEntries(CHALLENGES.map(stage => [stage.id, count]))

describe('craft save recovery', () => {
  it.each(['{', 'null', '{"stars":null,"drafts":null}', '{"stars":[],"drafts":42}'])('recovers unusable challenge data: %s', raw => {
    localStorage.setItem(CHALLENGE_KEY, raw)
    expect(readChallengeSave()).toEqual({ stars: {}, drafts: {}, best: {} })
  })
  it('retains valid stars, devices and best times while discarding damaged entries', () => {
    const module = craftTemplates()[0].course.modules[0]
    localStorage.setItem(CHALLENGE_KEY, JSON.stringify({
      stars: { 'first-drop': 3, 'bamboo-knock': 99, bogus: 3 },
      drafts: { 'first-drop': [null, module, { ...module, size: 'giant' }], 'bamboo-knock': 'bad' },
      best: { 'first-drop': 6.5, 'bamboo-knock': -1, 'maze-path': 'fast' },
    }))
    expect(readChallengeSave()).toEqual({ stars: { 'first-drop': 3 }, drafts: { 'first-drop': [module] }, best: { 'first-drop': 6.5 } })
  })
  it('continues at the earliest open unfinished stage', () => {
    expect(nextChallengeId({ stars: {} })).toBe('first-drop')
    expect(nextChallengeId({ stars: { 'first-drop': 3 } })).toBe(CHALLENGES[1].id)
    expect(nextChallengeId({ stars: allStars() })).toBe(CHALLENGES.at(-1)!.id)
  })
  it('keeps stages a player already cleared open when new stages are added before them', () => {
    // A save from the ten-stage campaign: the stages that existed then are cleared.
    const old = ['first-drop', 'bamboo-knock', 'rain-chain', 'low-spring', 'water-wheels', 'siphon-burst', 'no-pumps', 'spiral-tower', 'few-devices', 'grand-garden']
    const save = { stars: Object.fromEntries(old.map(id => [id, 2])) }
    CHALLENGES.forEach((stage, index) => { if (old.includes(stage.id)) expect(isStageOpen(save, index), stage.id).toBe(true) })
    // The new stages placed after a cleared stage are open, and play resumes at the first of them.
    expect(nextChallengeId(save)).toBe('maze-path')
    expect(campaignProgress(save)).toMatchObject({ cleared: old.length, total: CHALLENGES.length, stars: old.length * 2, complete: false })
  })
  it('locks a stage until the one before it has a star', () => {
    expect(isStageOpen({ stars: {} }, 0)).toBe(true)
    expect(isStageOpen({ stars: {} }, 1)).toBe(false)
    expect(isStageOpen({ stars: { [CHALLENGES[0].id]: 1 } }, 1)).toBe(true)
  })
  it('totals stars per chapter and finds stages with stars left to earn', () => {
    const save = { stars: { ...allStars(3), [CHALLENGES[6].id]: 1 } }
    expect(chapterStars(save, 0)).toEqual({ stars: 15, max: 15, cleared: true })
    expect(chapterStars(save, 1)).toEqual({ stars: 13, max: 15, cleared: true })
    expect(nextUnstarredStage(save)?.id).toBe(CHALLENGES[6].id)
    expect(nextUnstarredStage({ stars: allStars(3) })).toBeNull()
  })
  it('opens free building on the beginner garden and rejects malformed course devices', () => {
    const beginner = craftTemplates()[0].course
    expect(readCourse()).toMatchObject({ name: beginner.name, source: beginner.source })
    expect(readCourse().modules.map(item => item.kind)).toEqual(beginner.modules.map(item => item.kind))
    const course = craftTemplates()[1].course
    localStorage.setItem(CRAFT_KEY, JSON.stringify({ ...course, modules: [{ ...course.modules[0], turn: 'unknown' }] }))
    expect(readCourse().modules.map(item => item.kind)).toEqual(craftTemplates()[0].course.modules.map(item => item.kind))
    localStorage.setItem(CRAFT_KEY, JSON.stringify(course))
    expect(readCourse()).toEqual(course)
  })
  it('still starts when browser storage is disabled', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled') })
    expect(readChallengeSave()).toEqual({ stars: {}, drafts: {}, best: {} })
    expect(readCourse().modules.length).toBeGreaterThan(0)
    spy.mockRestore()
  })
})

describe('challenge flow', () => {
  const first = CHALLENGES[0]
  const empty = challengeCourse(first)
  const built = challengeCourse(first, first.solution)
  const state = { cleared: false, ready: true, started: false, briefing: false }

  it('coaches the first stage from adding a device to watching the water', () => {
    expect(coachStep(first, empty, state)).toBe('add')
    expect(coachStep(first, built, state)).toBe('pour')
    expect(coachStep(first, built, { ...state, started: true })).toBe('watch')
    expect(coachStep(first, built, { ...state, ready: false })).toBeNull()
    expect(coachStep(first, empty, { ...state, briefing: true })).toBeNull()
    expect(coachStep(first, empty, { ...state, cleared: true })).toBeNull()
    expect(coachStep(CHALLENGES[1], challengeCourse(CHALLENGES[1]), state)).toBeNull()
  })

  it('explains a missed run: course rules once water runs, then a late arrival', () => {
    const stepping = CHALLENGES.find(stage => stage.id === 'stepping-ponds')!
    const short = challengeCourse(stepping, stepping.solution.slice(0, 1))
    expect(missReason(stepping, short, judgeGoals(stepping, short, null, 0), null, 0)).toBeNull()
    expect(missReason(stepping, short, judgeGoals(stepping, short, null, 5), null, 5)).toMatch(/장치 3개 이상.*지금 1개/)
    const late = { arrival: 41, knocks: 0, surges: 0, wetShare: 1 }
    const full = challengeCourse(first, first.solution)
    expect(missReason(first, full, judgeGoals(first, full, late, 45), late, 45)).toBe('종착 연못까지 41초 걸렸어요. 30초 안에 닿아야 해요.')
    expect(missReason(first, full, judgeGoals(first, full, null, 31), null, 31)).toBe('30초 안에 종착 연못에 닿지 못했어요.')
  })

  it('notices the clear that finishes a chapter or the campaign, once', () => {
    const chapterOne = CHALLENGES.filter(stage => stage.chapter === 0)
    const last = chapterOne.at(-1)!
    const before = { stars: Object.fromEntries(chapterOne.slice(0, -1).map(stage => [stage.id, 2])) }
    const after = { stars: { ...before.stars, [last.id]: 1 } }
    expect(chapterCompletedBy(last, before, after)).toBe(0)
    expect(chapterCompletedBy(last, after, after)).toBeNull()
    const almost = { stars: { ...allStars(1), [CHALLENGES.at(-1)!.id]: 0 } }
    expect(campaignCompletedBy(almost, { stars: allStars(1) })).toBe(true)
    expect(campaignCompletedBy({ stars: allStars(1) }, { stars: allStars(2) })).toBe(false)
  })
})

describe('miss wording', () => {
  it('uses the object particle that fits the goal', () => {
    const noPumps = CHALLENGES.find(stage => stage.id === 'no-pumps')!
    const pumped = challengeCourse(noPumps, [{ ...noPumps.solution[0], id: 'lift', kind: 'screw' }])
    const goals = judgeGoals(noPumps, pumped, null, 3)
    expect(missReason(noPumps, pumped, goals, null, 3)).toMatch(/^목표 ‘장치 4개 이상’을 아직/)
    const four = challengeCourse(noPumps, [...noPumps.solution.slice(0, 3), { ...noPumps.solution[0], id: 'lift', kind: 'screw' }])
    expect(missReason(noPumps, four, judgeGoals(noPumps, four, null, 3), null, 3)).toMatch(/^목표 ‘양수 장치 없이’를 아직/)
  })
})
