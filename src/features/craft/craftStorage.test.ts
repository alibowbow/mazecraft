import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHALLENGES } from '../waterSimulation/garden/challenges'
import { craftTemplates } from '../waterSimulation/garden/craft'
import { CRAFT_KEY, CHALLENGE_KEY, nextChallengeId, readChallengeSave, readCourse, writeChallengeSave } from './craftStorage'

beforeEach(() => localStorage.clear())

describe('craft save recovery', () => {
  it.each(['{', 'null', '{"stars":null,"drafts":null}', '{"stars":[],"drafts":42}'])('recovers unusable challenge data: %s', raw => {
    localStorage.setItem(CHALLENGE_KEY, raw)
    expect(readChallengeSave()).toEqual({ stars: {}, drafts: {} })
  })
  it('retains valid stars and devices while discarding damaged entries', () => {
    const module = craftTemplates()[0].course.modules[0]
    localStorage.setItem(CHALLENGE_KEY, JSON.stringify({ stars: { 'first-drop': 3, 'bamboo-knock': 99, bogus: 3 },
      drafts: { 'first-drop': [null, module, { ...module, size: 'giant' }], 'bamboo-knock': 'bad' } }))
    expect(readChallengeSave()).toEqual({ stars: { 'first-drop': 3 }, drafts: { 'first-drop': [module] } })
  })
  it('continues at the earliest unlocked unfinished stage', () => {
    expect(nextChallengeId({ stars: {}, drafts: {} })).toBe('first-drop')
    expect(nextChallengeId({ stars: { 'first-drop': 3 }, drafts: {} })).toBe('bamboo-knock')
    expect(nextChallengeId({ stars: Object.fromEntries(CHALLENGES.map(stage => [stage.id, 3])), drafts: {} })).toBe(CHALLENGES.at(-1)!.id)
  })
  it('keeps exhibition progress isolated from ordinary progress', () => {
    writeChallengeSave({ stars: { 'first-drop': 2 }, drafts: {} })
    writeChallengeSave({ stars: { 'first-drop': 3, 'bamboo-knock': 1 }, drafts: {} }, `${CHALLENGE_KEY}.tripothon`)
    localStorage.removeItem(`${CHALLENGE_KEY}.tripothon`)
    expect(readChallengeSave().stars).toEqual({ 'first-drop': 2 })
  })
  it('rejects malformed course devices instead of crashing compilation', () => {
    const course = craftTemplates()[0].course
    localStorage.setItem(CRAFT_KEY, JSON.stringify({ ...course, modules: [{ ...course.modules[0], turn: 'unknown' }] }))
    expect(readCourse().modules.map(item => item.kind)).toEqual(craftTemplates()[1].course.modules.map(item => item.kind))
    localStorage.setItem(CRAFT_KEY, JSON.stringify(course))
    expect(readCourse()).toEqual(course)
  })
  it('still starts when browser storage is disabled', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled') })
    expect(readChallengeSave()).toEqual({ stars: {}, drafts: {} })
    expect(readCourse().modules.length).toBeGreaterThan(0)
    spy.mockRestore()
  })
})
