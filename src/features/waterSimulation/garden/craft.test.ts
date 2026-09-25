import { describe, expect, it } from 'vitest'
import { compileCraft, CRAFT_MODULES, craftTemplates, hasSpout, type CraftCourse, type CraftExit, type CraftKind, type CraftModule, type CraftSize, type CraftTurn } from './craft'
import { compileGarden } from './layout'
import { GardenSimulation } from './simulation'
import { seededRandom } from './designs'

const grid = { rows: 8, cols: 8, activeCellCount: 64 }
const module = (kind: CraftKind, overrides: Partial<CraftModule> = {}): CraftModule =>
  ({ id: kind, kind, turn: 'straight', exit: 'plain', size: 'medium', seed: 1, wheels: false, ...overrides })

describe('craft mode', () => {
  it.each(craftTemplates().map(template => [template.id, template] as const))('runs the %s template as a working garden', (_, template) => {
    const result = compileCraft(template.course)
    expect(result.issues).toEqual([])
    const layout = compileGarden(result.design!)
    const simulation = new GardenSimulation(layout, grid)
    for (let step = 0; step < 120 * 4; step++) simulation.advance(0.25, 1)
    const state = simulation.snapshot()
    expect(state.diagnostics.reachedExit).toBe(true)
    expect(state.diagnostics.escaped).toBe(0)
    expect(state.diagnostics.massError / state.diagnostics.injected).toBeLessThan(1e-9)
    layout.pools.forEach((pool, i) => expect(state.garden.levels[i], `pool ${i}`).toBeLessThan(pool.brim - 0.02))
  }, 60_000)

  it('builds every module, size and turn after a maze, or says why not', () => {
    const turns: CraftTurn[] = ['straight', 'left', 'right'], sizes: CraftSize[] = ['small', 'medium', 'large']
    for (const info of CRAFT_MODULES) for (const turn of turns) for (const size of sizes) {
      const exits: CraftExit[] = hasSpout(info.kind) ? ['plain', 'wheel', 'chain'] : ['plain']
      for (const exit of exits) {
        const course: CraftCourse = { version: 1, name: 'test', source: 5.5, modules: [module('maze', { size: 'small' }), module(info.kind, { turn, size, exit })] }
        const result = compileCraft(course)
        if (!result.design) {
          expect(result.issues.length, `${info.kind} ${turn} ${size}`).toBeGreaterThan(0)
          expect(result.issues[0].message).toMatch(/[가-힣]/)
          continue
        }
        const layout = compileGarden(result.design)
        for (const edge of layout.edges) if (edge.kind === 'spout') {
          expect(layout.pools[edge.b].brim, `${info.kind} ${turn} ${size}: rim below the spout slab`).toBeLessThan(edge.crest - 0.15)
        }
      }
    }
  }, 60_000)

  it('never fails on random courses: a design that compiles, or a clear reason', () => {
    const random = seededRandom('craft-fuzz')
    const kinds = CRAFT_MODULES.map(info => info.kind)
    const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]
    let built = 0
    for (let n = 0; n < 40; n++) {
      const modules = Array.from({ length: 2 + Math.floor(random() * 4) }, () => {
        const kind = pick(kinds)
        return module(kind, { turn: pick(['straight', 'left', 'right'] as const), size: pick(['small', 'medium', 'large'] as const),
          exit: hasSpout(kind) ? pick(['plain', 'tipper', 'wheel', 'chain'] as const) : 'plain', seed: Math.floor(random() * 100) })
      })
      const result = compileCraft({ version: 1, name: 'fuzz', source: 3 + random() * 3, modules })
      if (!result.design) { expect(result.issues[0].message.length).toBeGreaterThan(5); continue }
      expect(() => compileGarden(result.design!)).not.toThrow()
      built++
    }
    expect(built).toBeGreaterThan(5)
  }, 60_000)
})
