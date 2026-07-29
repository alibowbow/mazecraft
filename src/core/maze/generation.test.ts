import { describe, expect, it } from 'vitest'
import {
  createEmptyGraph,
  generateDfsMaze,
  generateKruskalMaze,
  generateMaze,
  generateMazeCandidateAtIndex,
  generatePrimMaze,
  getCell,
  getVisualOpeningDirection,
  openPassage,
  solveMaze,
  validateMaze,
} from './index'

describe('deterministic maze generation', () => {
  it.each([
    ['dfs', generateDfsMaze],
    ['kruskal', generateKruskalMaze],
    ['prim', generatePrimMaze],
  ] as const)('generates the same %s graph for the same seed', (_, generator) => {
    const options = { rows: 18, cols: 21, seed: 'repeatable-seed' }
    expect(generator(options)).toEqual(generator(options))
  })

  it('keeps both halves of a removed wall symmetrical', () => {
    const graph = createEmptyGraph(2, 2)
    expect(openPassage(graph, { row: 0, col: 0 }, { row: 0, col: 1 })).toBe(true)
    expect(getCell(graph, { row: 0, col: 0 })?.walls.right).toBe(false)
    expect(getCell(graph, { row: 0, col: 1 })?.walls.left).toBe(false)
  })

  it('chooses a visual entrance without opening the graph boundary', () => {
    const graph = createEmptyGraph(2, 2)
    expect(getVisualOpeningDirection(graph, { row: 0, col: 0 })).toBe('top')
    expect(getCell(graph, { row: 0, col: 0 })?.walls.top).toBe(true)
  })

  it.each(['dfs', 'kruskal', 'prim'] as const)(
    'solver reaches optimized endpoints for %s',
    (algorithm) => {
      const generated = generateMaze({
        rows: 20,
        cols: 20,
        seed: 'solvable',
        algorithm,
      })
      const solution = solveMaze(
        generated.graph,
        generated.start,
        generated.end,
      )
      expect(solution.solved).toBe(true)
      expect(solution.path[0]).toEqual(generated.start)
      expect(solution.path.at(-1)).toEqual(generated.end)
      expect(solution.distance).toBeGreaterThan(0)
    },
  )

  it('records a deterministic passage trace for creation animation', () => {
    const request = {
      rows: 12,
      cols: 12,
      seed: 'trace-seed',
      difficulty: 'normal',
      algorithm: 'dfs',
      candidateCount: 1,
    } as const
    const first = generateMazeCandidateAtIndex(request, 0)
    const second = generateMazeCandidateAtIndex(request, 0)
    expect(first.generationTrace).toEqual(second.generationTrace)
    expect(first.generationTrace.length).toBeGreaterThan(100)
  })

  it('detects a disconnected maze instead of presenting it as valid', () => {
    const graph = createEmptyGraph(3, 3)
    const validation = validateMaze(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 2 },
    )
    expect(validation.valid).toBe(false)
    expect(validation.solvable).toBe(false)
    expect(validation.issues.map((item) => item.code)).toContain(
      'disconnected-regions',
    )
    expect(validation.issues.map((item) => item.code)).toContain('unreachable-end')
  })
})
