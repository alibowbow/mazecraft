import { describe, expect, it } from 'vitest'
import { compileCraft, craftModule, craftTemplates, type CraftCourse } from './craft'
import { adviseCraft } from './craftAdvisor'

const course = (source: number, kinds: Parameters<typeof craftModule>[], name = 'test'): CraftCourse =>
  ({ version: 1, name, source, modules: kinds.map(([kind, overrides]) => craftModule(kind, { seed: 3, ...overrides })) })

describe('craft advisor', () => {
  it('fixes a course that runs out of height, with the numbers that change', () => {
    const tall = course(2.5, [['maze'], ['maze'], ['maze'], ['maze']])
    const result = compileCraft(tall)
    expect(result.issues[0].problem).toMatch(/height/)
    expect(result.plan.failure).toBeDefined()
    const advice = adviseCraft(tall, result)
    expect(advice.length).toBeGreaterThan(0)
    for (const item of advice) expect(compileCraft(item.course).issues).toEqual([])
    expect(advice.some(item => /수원 높이: 2\.5 m → \d\.\d m/.test(item.title) || /스크류|노리아/.test(item.title))).toBe(true)
  })

  it('turns devices apart when they collide, and shows where', () => {
    for (const [kinds, turn] of [[['pond', 'pond', 'pond', 'pond'], 'left'], [['terraces', 'terraces', 'terraces', 'terraces'], 'right'], [['aqueduct', 'aqueduct', 'aqueduct', 'aqueduct'], 'left']] as const) {
      const spiral = course(6.5, kinds.map(kind => [kind, { turn }] as Parameters<typeof craftModule>))
      const result = compileCraft(spiral)
      expect(result.issues[0].problem).toBe('clash')
      expect(result.plan.failure?.boxes?.length).toBeGreaterThan(0)
      const advice = adviseCraft(spiral, result)
      expect(advice.length, kinds.join()).toBeGreaterThan(0)
      for (const item of advice) expect(compileCraft(item.course).issues).toEqual([])
    }
  })

  it('moves a shishi-odoshi that has no basin to pour into', () => {
    const misplaced = course(4.3, [['maze', { exit: 'tipper' }], ['zigzag']])
    const result = compileCraft(misplaced)
    expect(result.issues[0].problem).toBe('tipper')
    const advice = adviseCraft(misplaced, result)
    expect(advice[0].title).toContain('출구')
  })

  it('has nothing to fix in a working course', () => {
    for (const template of craftTemplates()) expect(adviseCraft(template.course)).toEqual([])
  })
})
