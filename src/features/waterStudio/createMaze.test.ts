import { describe, expect, it } from 'vitest'
import { createGeneratedWaterMaze, DEFAULT_WATER_MAZE, WATER_MAZE_SHAPES } from './createMaze'
import { buildFluidLayout } from '../waterSimulation/freeSurface/layout'

describe('water studio maze creation', () => {
  it.each(['dfs', 'prim', 'kruskal'] as const)('reproduces the selected %s maze from its seed', algorithm => {
    const options = { ...DEFAULT_WATER_MAZE, rows: 14, cols: 16, algorithm, seed: 'my-water-garden' }
    const first = createGeneratedWaterMaze(options)
    const second = createGeneratedWaterMaze(options)
    expect(first.mazeGraph).toEqual(second.mazeGraph)
    expect(first.startCell).toEqual(second.startCell)
    expect(first.endCell).toEqual(second.endCell)
    expect(first.seed).toBe(options.seed)
    expect(first.mazeGraph.rows).toBe(14)
    expect(first.mazeGraph.cols).toBe(16)
    expect(createGeneratedWaterMaze({ ...options, seed: 'another-garden' }).mazeGraph).not.toEqual(first.mazeGraph)
  })
  it.each(WATER_MAZE_SHAPES)('retains the %s mask through fluid layout creation', (shape) => {
    const project = createGeneratedWaterMaze({ ...DEFAULT_WATER_MAZE, shape, rows: 16, cols: 16 })
    const original = JSON.stringify(project.mazeGraph)
    const layout = buildFluidLayout(project)
    expect(Array.from(layout.activeCells, Boolean)).toEqual(project.mazeGraph.cells.map(cell => cell.active))
    expect(JSON.stringify(project.mazeGraph)).toBe(original)
    expect(layout.activeCellCount).toBeGreaterThan(60)
    if (shape !== 'rectangle') expect(layout.activeCellCount).toBeLessThan(256)
  })
})
