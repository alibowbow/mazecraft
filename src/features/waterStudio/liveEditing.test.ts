import { describe, expect, it } from 'vitest'
import { createWaterStudioProject } from './presets'
import { createGeneratedWaterMaze, DEFAULT_WATER_MAZE } from './createMaze'
import type { MazeProject } from '../../core/maze'
import { editWaterMazeWall, resizeWaterMaze } from './liveEditing'
import { buildFluidLayout } from '../waterSimulation/freeSurface/layout'
import { FreeSurfaceSolver } from '../waterSimulation/freeSurface/solver'
import type { FluidResume } from '../waterSimulation/freeSurface/types'

describe('live water topology', () => {
  const wallDensity = ({ mazeGraph: g }: MazeProject) => g.cells.reduce((count, cell) => count + Number(cell.active && cell.col + 1 < g.cols && g.cells[cell.index + 1].active && cell.walls.right)
    + Number(cell.active && cell.row + 1 < g.rows && g.cells[cell.index + g.cols].active && cell.walls.bottom), 0) / Math.max(g.rows, g.cols)
  it('adds visible passages and branches instead of just subdividing the same maze', () => {
    const original = createGeneratedWaterMaze({ ...DEFAULT_WATER_MAZE, rows: 8, cols: 8 })
    const finer = resizeWaterMaze(original, 16, 16)
    expect(wallDensity(finer)).toBeGreaterThan(wallDensity(original) * 1.8)
    expect(finer.mazeMetrics.branches).toBeGreaterThan(original.mazeMetrics.branches)
    expect(finer.mazeMetrics.solvable).toBe(true)
    expect(resizeWaterMaze(original, 16, 16).mazeGraph).toEqual(finer.mazeGraph)
  })
  it('retains the original mask and walls after moving the slider down and back up', () => {
    const original = createWaterStudioProject('garden')
    const coarser = resizeWaterMaze(original, 4, 4)
    const finer = resizeWaterMaze(coarser, 24, 24, original)
    expect(finer.mazeGraph).toEqual(resizeWaterMaze(original, 24, 24).mazeGraph)
    expect(resizeWaterMaze(finer, original.grid.rows, original.grid.cols, original)).toBe(original)
    expect(resizeWaterMaze(finer, 24, 24, original)).toBe(finer)
  })
  it('retains liquid sampling and particle budget when maze density increases', () => {
    const original = createGeneratedWaterMaze({ ...DEFAULT_WATER_MAZE, rows: 8, cols: 8 })
    const before = buildFluidLayout(original)
    const after = buildFluidLayout(resizeWaterMaze(original, 32, 32), before.capacity)
    expect(after.walls.length).toBeGreaterThan(before.walls.length * 4)
    expect(after.capacity).toBe(before.capacity)
    expect(after.radius).toBe(before.radius)
    expect(after.particleArea).toBe(before.particleArea)
  })
  it('toggles both sides of an internal edge without modifying the original', () => {
    const original = createWaterStudioProject('garden')
    const changed = editWaterMazeWall(original, 1, .5)!
    expect(changed.mazeGraph.cells[0].walls.right).toBe(!original.mazeGraph.cells[0].walls.right)
    expect(changed.mazeGraph.cells[1].walls.left).toBe(changed.mazeGraph.cells[0].walls.right)
    expect(editWaterMazeWall(original, 0, .5)).toBeNull()
  })
  it('retains the silhouette and paired wall topology at a different resolution', () => {
    const resized = resizeWaterMaze(createWaterStudioProject('garden'), 16, 12)
    const g = resized.mazeGraph
    expect(g.cells).toHaveLength(192)
    expect(g.cells.some(cell => !cell.active)).toBe(true)
    for (const cell of g.cells) if (cell.active) {
      const right = g.cells[cell.row * g.cols + cell.col + 1]
      if (cell.col + 1 < g.cols && right.active) expect(cell.walls.right).toBe(right.walls.left)
      const down = g.cells[(cell.row + 1) * g.cols + cell.col]
      if (down?.active) expect(cell.walls.bottom).toBe(down.walls.top)
    }
  })
  it('preserves particles, elapsed time and mass when new walls displace accepted water', () => {
    const original = createWaterStudioProject('garden')
    const layout = buildFluidLayout(original), solver = new FreeSurfaceSolver(layout)
    for (let i = 0; i < 240; i++) solver.step(1 / 120, 1)
    const before = solver.snapshot()
    const resume: FluidResume = { snapshot: before, ...layout, paused: true, inflow: true }
    const resized = resizeWaterMaze(editWaterMazeWall(original, 3, .5)!, 10, 12)
    const nextLayout = buildFluidLayout(resized, resume.capacity)
    nextLayout.capacity = Math.max(nextLayout.capacity, before.count)
    const afterSolver = new FreeSurfaceSolver(nextLayout)
    afterSolver.restore(resume)
    const after = afterSolver.snapshot()
    expect(after.count).toBe(before.count)
    expect(after.diagnostics.time).toBe(before.diagnostics.time)
    expect(after.diagnostics.injected).toBeCloseTo(before.diagnostics.injected, 8)
    expect(after.diagnostics.massError).toBe(0)
    for (let i = 0; i < after.count; i++) {
      const x = after.positions[i * 2], y = after.positions[i * 2 + 1]
      expect(nextLayout.walls.some(w => x > w.x0 && x < w.x1 && y > w.y0 && y < w.y1)).toBe(false)
    }
    for (let i = 0; i < 120; i++) afterSolver.step(1 / 120, 0)
    expect(afterSolver.snapshot().diagnostics.massError).toBe(0)
  })
})
