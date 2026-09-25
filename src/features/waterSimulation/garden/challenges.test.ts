import { describe, expect, it } from 'vitest'
import { compileCraft } from './craft'
import { compileGarden } from './layout'
import { GardenSimulation } from './simulation'
import { GardenProgressTracker } from './progress'
import { CHALLENGES, challengeCourse, judgeGoals, starsFor } from './challenges'

const grid = { rows: 8, cols: 8, activeCellCount: 64 }

describe('challenge stages', () => {
  for (const challenge of CHALLENGES) {
    it(`${challenge.name} can be cleared with three stars by its own rules`, () => {
      // The known solution keeps to the stage's palette and exits.
      for (const module of challenge.solution) {
        expect(challenge.palette).toContain(module.kind)
        expect(challenge.exits).toContain(module.exit)
      }
      const course = challengeCourse(challenge, challenge.solution)
      const result = compileCraft(course)
      expect(result.issues).toEqual([])
      const layout = compileGarden(result.design!)
      const simulation = new GardenSimulation(layout, grid)
      const tracker = new GardenProgressTracker(layout)
      const limit = Math.max(60, ...challenge.goals.map(goal => goal.kind === 'reach' ? goal.within : 0))
      let time = 0, cleared: number | null = null
      while (time < limit && cleared === null) {
        simulation.advance(0.1, 1); time += 0.1
        const progress = tracker.update(simulation.snapshot().garden)
        if (judgeGoals(challenge, course, progress, time).every(state => state === 'met')) cleared = time
      }
      expect(cleared, 'cleared').not.toBeNull()
      expect(starsFor(challenge, course, tracker.current, cleared!)).toBe(3)
    }, 120_000)
  }

  it('judges course goals before the water runs, and fails a late arrival', () => {
    const stage = CHALLENGES.find(challenge => challenge.id === 'no-pumps')!
    const pumped = challengeCourse(stage, [...stage.solution.slice(0, 3), { ...stage.solution[0], id: 'screw', kind: 'screw' }])
    const states = judgeGoals(stage, pumped, null, 0)
    expect(states[1]).toBe('failed')
    const reach = CHALLENGES[0]
    const late = judgeGoals(reach, challengeCourse(reach, reach.solution), { arrival: null, knocks: 0, surges: 0, wetShare: 0 }, 999)
    expect(late[0]).toBe('failed')
  })
})
