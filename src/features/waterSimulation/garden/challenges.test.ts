import { describe, expect, it } from 'vitest'
import { compileCraft, CRAFT_MODULES, type CraftKind, type CraftModule, type CraftTurn } from './craft'
import { compileGarden } from './layout'
import { GardenSimulation } from './simulation'
import { GardenProgressTracker } from './progress'
import { CHALLENGES, CHAPTERS, challengeCourse, goalProgress, goalText, judgeGoals, starBreakdown, starsFor, type Challenge } from './challenges'

const grid = { rows: 8, cols: 8, activeCellCount: 64 }
const TURNS: CraftTurn[] = ['straight', 'left', 'right']
let serial = 0
const device = (kind: CraftKind, size: CraftModule['size'] = 'small'): CraftModule =>
  ({ id: `probe-${serial++}`, kind, turn: 'straight', exit: 'plain', size, seed: 7, wheels: false })
const stageById = (id: string) => CHALLENGES.find(stage => stage.id === id)!

/** Whether any choice of directions lets these devices build on the stage. */
function buildsOnStage(stage: Challenge, added: CraftModule[]): boolean {
  const modules = [...stage.locked, ...added]
  for (let code = 0; code < 3 ** added.length; code++) {
    let c = code
    const turned = modules.map((module, k) => {
      if (k < stage.locked.length) return module
      const turn = TURNS[c % 3]; c = Math.floor(c / 3)
      return { ...module, turn }
    })
    if (!compileCraft({ version: 1, name: stage.name, source: stage.source, modules: turned }).issues.length) return true
  }
  return false
}

/** Run a stage's course through the garden physics until its goals are all met, or time runs out. */
function play(stage: Challenge, added: CraftModule[], limit: number) {
  const course = challengeCourse(stage, added)
  const result = compileCraft(course)
  expect(result.issues).toEqual([])
  const layout = compileGarden(result.design!)
  const simulation = new GardenSimulation(layout, grid)
  const tracker = new GardenProgressTracker(layout)
  let time = 0, cleared: number | null = null
  while (time < limit && cleared === null) {
    simulation.advance(0.1, 1); time += 0.1
    const progress = tracker.update(simulation.snapshot().garden)
    if (judgeGoals(stage, course, progress, time).every(state => state === 'met')) cleared = time
  }
  simulation.dispose?.()
  return { course, cleared, progress: tracker.current }
}

describe('challenge stages', () => {
  for (const challenge of CHALLENGES) {
    it(`${challenge.name} can be cleared with three stars by its own rules`, () => {
      // The known solution keeps to the stage's palette and exits.
      for (const module of challenge.solution) {
        expect(challenge.palette).toContain(module.kind)
        expect(challenge.exits).toContain(module.exit)
      }
      const limit = Math.max(60, ...challenge.goals.map(goal => goal.kind === 'reach' ? goal.within : 0))
      const { course, cleared, progress } = play(challenge, challenge.solution, limit)
      expect(cleared, 'cleared').not.toBeNull()
      expect(starsFor(challenge, course, progress, cleared!)).toBe(3)
      // Par time keeps headroom over the solution, so a frame or two of latency still earns the star.
      expect(progress.arrival ?? cleared!).toBeLessThanOrEqual(challenge.par.time - 1.5)
    }, 120_000)
  }

  it('form a campaign of four chapters with five stages each, every stage briefed and hinted', () => {
    expect(new Set(CHALLENGES.map(stage => stage.id)).size).toBe(CHALLENGES.length)
    expect(CHAPTERS).toHaveLength(4)
    CHAPTERS.forEach((_, c) => expect(CHALLENGES.filter(stage => stage.chapter === c)).toHaveLength(5))
    // Chapters run in order.
    CHALLENGES.forEach((stage, k) => { if (k) expect(stage.chapter).toBeGreaterThanOrEqual(CHALLENGES[k - 1].chapter) })
    for (const stage of CHALLENGES) {
      expect(stage.story.length, stage.id).toBeGreaterThan(10)
      expect(stage.tip.title && stage.tip.text, stage.id).toBeTruthy()
      expect(stage.hints.every(hint => hint.length > 10), stage.id).toBe(true)
      expect(stage.par.devices).toBeGreaterThanOrEqual(stage.solution.length)
      if (stage.tip.device) expect(stage.palette).toContain(stage.tip.device)
      if (stage.tip.exit) expect(stage.exits).toContain(stage.tip.exit)
    }
  })

  it('introduce each device before a stage expects it', () => {
    const met = new Set<CraftKind>()
    for (const stage of CHALLENGES) {
      for (const module of stage.solution) {
        const introduced = met.has(module.kind) || stage.tip.device === module.kind || stage.locked.some(locked => locked.kind === module.kind)
        // A device first used in a solution is the one its stage introduces, or one shown beside it (spiral with the siphon, terraces with the rain chain).
        if (!introduced) expect(['spiral', 'terraces', 'aqueduct'], `${stage.id} uses ${module.kind} unannounced`).toContain(module.kind)
      }
      stage.solution.forEach(module => met.add(module.kind))
      stage.palette.forEach(kind => { if (stage.tip.device === kind) met.add(kind) })
    }
    expect([...met].sort()).toEqual(CRAFT_MODULES.map(info => info.kind).sort())
  })

  it('need their lesson: low springs need a lift, stepping ponds need ponds, the quick stage needs fast devices', () => {
    // 징검다리 연못: any three devices other than three ponds run out of height.
    const stepping = stageById('stepping-ponds')
    const kinds: CraftKind[] = ['pond', 'maze', 'terraces']
    for (const a of kinds) for (const b of kinds) for (const c of kinds) {
      const allPonds = a === 'pond' && b === 'pond' && c === 'pond'
      expect(buildsOnStage(stepping, [device(a), device(b), device(c)]), `${a} ${b} ${c}`).toBe(allPonds)
    }
    // 미로 삼부작 and 낮은 샘: without a lift the course cannot reach the end.
    const trilogy = stageById('maze-trilogy')
    for (const size of ['small', 'medium', 'large'] as const) expect(buildsOnStage(trilogy, [device('maze'), device('maze'), device('maze', size)])).toBe(false)
    const low = stageById('low-spring')
    for (const a of ['maze', 'pond'] as const) for (const b of ['maze', 'pond'] as const) expect(buildsOnStage(low, [device(a), device(b)]), `${a} ${b}`).toBe(false)
    // 높은 곳의 사이펀: a siphon cannot pour from the low spring itself.
    expect(buildsOnStage(stageById('siphon-tower'), [device('siphon', 'medium')])).toBe(false)
    // 서둘러: three maze basins arrive too late.
    const quick = stageById('quick-flow')
    const slow = play(quick, [device('maze'), device('maze'), device('maze')], 30)
    expect(slow.cleared).toBeNull()
    expect(slow.progress.arrival ?? Infinity).toBeGreaterThan(25)
  }, 120_000)

  it('judges course goals before the water runs, and fails a late arrival', () => {
    const stage = stageById('no-pumps')
    const pumped = challengeCourse(stage, [...stage.solution.slice(0, 3), { ...stage.solution[0], id: 'screw', kind: 'screw' }])
    const states = judgeGoals(stage, pumped, null, 0)
    expect(states[1]).toBe('failed')
    const reach = CHALLENGES[0]
    const late = judgeGoals(reach, challengeCourse(reach, reach.solution), { arrival: null, knocks: 0, surges: 0, wetShare: 0 }, 999)
    expect(late[0]).toBe('failed')
  })

  it('counts devices of a kind and shows live progress for each goal', () => {
    const trilogy = stageById('maze-trilogy')
    const two = challengeCourse(trilogy, trilogy.solution.slice(0, 2))
    expect(goalText(trilogy.goals[0])).toBe('미로 수조 3개 쓰기')
    expect(judgeGoals(trilogy, two, null, 0)[0]).toBe('failed')
    expect(goalProgress(trilogy.goals[0], two, null, 0)).toBe('2/3')
    expect(judgeGoals(trilogy, challengeCourse(trilogy, trilogy.solution), null, 0)[0]).toBe('met')
    const knock = stageById('bamboo-knock')
    expect(goalProgress(knock.goals[0], challengeCourse(knock), { arrival: null, knocks: 5, surges: 0, wetShare: 0 }, 10)).toBe('3/3')
    expect(goalProgress(knock.goals[1], challengeCourse(knock), null, 12.4)).toBe('12초')
  })

  it('gives one star when the answer was shown, and says which stars were missed', () => {
    const stage = CHALLENGES[0]
    const course = challengeCourse(stage, stage.solution)
    const fast = { arrival: 6, knocks: 0, surges: 0, wetShare: 1 }
    expect(starBreakdown(stage, course, fast, 6, true)).toMatchObject({ stars: 1, assisted: true, time: true, devices: true })
    const slow = { ...fast, arrival: 25 }
    const crowded = challengeCourse(stage, [...stage.solution, ...stage.solution.map(module => ({ ...module, id: `${module.id}-2` }))])
    expect(starBreakdown(stage, crowded, slow, 25)).toMatchObject({ stars: 1, time: false, devices: false, added: 2, arrival: 25 })
  })
})

describe('campaign index', () => {
  it('matches the stage data that the home progress card summarizes', async () => {
    const { STAGE_INDEX, CHAPTER_NAMES } = await import('../../craft/campaignIndex')
    expect(STAGE_INDEX.map(({ id, name, chapter }) => ({ id, name, chapter }))).toEqual(CHALLENGES.map(({ id, name, chapter }) => ({ id, name, chapter })))
    expect([...CHAPTER_NAMES]).toEqual(CHAPTERS.map(chapter => chapter.name))
  })
})
