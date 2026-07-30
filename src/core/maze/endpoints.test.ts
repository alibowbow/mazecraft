import { describe, expect, it } from 'vitest'
import {
  createEmptyGraph,
  openPassage,
  optimizeEndpoints,
  solveMaze,
} from './index'
import type { CellPosition, MazeGraph } from './types'

function connectPath(graph: MazeGraph, path: readonly CellPosition[]): void {
  for (let index = 1; index < path.length; index += 1) {
    expect(openPassage(graph, path[index - 1], path[index])).toBe(true)
  }
}

describe('endpoint optimization', () => {
  it('uses the topmost and bottommost mask boundary rows of the largest component', () => {
    const largestComponent = [
      { row: 2, col: 2 },
      { row: 2, col: 3 },
      { row: 3, col: 3 },
      { row: 3, col: 2 },
      { row: 4, col: 2 },
      { row: 4, col: 3 },
      { row: 4, col: 4 },
      { row: 5, col: 4 },
      { row: 5, col: 3 },
    ]
    const active = new Set([
      '0:0',
      '0:1',
      '6:6',
      ...largestComponent.map(({ row, col }) => `${row}:${col}`),
    ])
    const graph = createEmptyGraph(7, 7, {
      mask: Array.from({ length: 7 }, (_, row) =>
        Array.from({ length: 7 }, (_, col) => active.has(`${row}:${col}`)),
      ),
    })
    connectPath(graph, [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ])
    connectPath(graph, largestComponent)

    const endpoints = optimizeEndpoints(graph)

    expect(endpoints).toEqual({
      start: { row: 2, col: 2 },
      end: { row: 5, col: 3 },
      distance: 8,
      componentSize: largestComponent.length,
    })
    expect(
      solveMaze(graph, endpoints.start, endpoints.end).distance,
    ).toBe(endpoints.distance)
  })

  it('maximizes graph distance and resolves equal pairs deterministically', () => {
    const graph = createEmptyGraph(2, 2)
    for (const [from, to] of [
      [{ row: 0, col: 0 }, { row: 0, col: 1 }],
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 0 }, { row: 1, col: 1 }],
    ] as const) {
      expect(openPassage(graph, from, to)).toBe(true)
    }

    expect(optimizeEndpoints(graph)).toEqual({
      start: { row: 0, col: 0 },
      end: { row: 1, col: 1 },
      distance: 2,
      componentSize: 4,
    })
    expect(optimizeEndpoints(graph)).toEqual(optimizeEndpoints(graph))
  })

  it('uses the same active cell for a single-cell mask', () => {
    const graph = createEmptyGraph(5, 6, {
      mask: Array.from({ length: 5 }, (_, row) =>
        Array.from({ length: 6 }, (_, col) => row === 3 && col === 4),
      ),
    })

    expect(optimizeEndpoints(graph)).toEqual({
      start: { row: 3, col: 4 },
      end: { row: 3, col: 4 },
      distance: 0,
      componentSize: 1,
    })
  })
})
