import { describe, expect, it } from 'vitest'
import {
  calculateMazeMetrics,
  createEmptyGraph,
  findConnectedComponents,
  generateMaze,
  getVisualOpeningDirection,
  optimizeEndpoints,
  repairMaze,
  rotateMaze90,
  solveMaze,
} from './index'

describe('maze analysis and repair', () => {
  it('chooses top and bottom endpoints on the largest connected component using graph distance', () => {
    const generated = generateMaze({
      rows: 15,
      cols: 17,
      seed: 'diameter',
      algorithm: 'dfs',
    })
    const endpoints = optimizeEndpoints(generated.graph)
    const solution = solveMaze(generated.graph, endpoints.start, endpoints.end)
    expect(endpoints.componentSize).toBe(15 * 17)
    expect(endpoints.distance).toBe(solution.distance)
    expect(solution.distance).toBeGreaterThan(30)
    expect(endpoints.start.row).toBe(0)
    expect(endpoints.end.row).toBe(generated.graph.rows - 1)
    expect(getVisualOpeningDirection(generated.graph, endpoints.start)).toBe('top')
    expect(getVisualOpeningDirection(generated.graph, endpoints.end)).toBe('bottom')
  })

  it.each(['dfs', 'kruskal', 'prim'] as const)(
    'uses a top entrance and bottom exit for %s',
    (algorithm) => {
      for (let seed = 0; seed < 12; seed += 1) {
        const generated = generateMaze({
          rows: 24,
          cols: 24,
          seed: `boundary-endpoints-${seed}`,
          algorithm,
        })
        expect(generated.start.row).toBe(0)
        expect(generated.end.row).toBe(generated.graph.rows - 1)
        expect(getVisualOpeningDirection(generated.graph, generated.start)).toBe('top')
        expect(getVisualOpeningDirection(generated.graph, generated.end)).toBe('bottom')
      }
    },
  )

  it('calculates Maze IQ metrics from graph structure', () => {
    const generated = generateMaze({
      rows: 22,
      cols: 22,
      seed: 'metrics',
      algorithm: 'kruskal',
    })
    const metrics = calculateMazeMetrics(
      generated.graph,
      generated.start,
      generated.end,
    )
    expect(metrics.activeCells).toBe(22 * 22)
    expect(metrics.componentCount).toBe(1)
    expect(metrics.solvable).toBe(true)
    expect(metrics.pathLength).toBeGreaterThan(1)
    expect(metrics.difficultyScore).toBeGreaterThanOrEqual(0)
    expect(metrics.difficultyScore).toBeLessThanOrEqual(100)
    expect(metrics.loopCount).toBe(0)
  })

  it('auto-repairs adjacent disconnected passage regions', () => {
    const graph = createEmptyGraph(3, 3)
    const repaired = repairMaze(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 2 },
    )
    expect(findConnectedComponents(repaired.graph)).toHaveLength(1)
    expect(repaired.validation.solvable).toBe(true)
    expect(repaired.repairs).toContain('disconnected-regions')
  })

  it('preserves a solution while rotating a non-square graph', () => {
    const generated = generateMaze({
      rows: 8,
      cols: 13,
      seed: 'rotate',
      algorithm: 'prim',
    })
    const rotated = rotateMaze90(
      generated.graph,
      generated.start,
      generated.end,
    )
    expect(rotated.graph.rows).toBe(13)
    expect(rotated.graph.cols).toBe(8)
    expect(
      solveMaze(rotated.graph, rotated.start!, rotated.end!).solved,
    ).toBe(true)
  })
})
