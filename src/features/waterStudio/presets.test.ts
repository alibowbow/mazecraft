import { describe, expect, it } from 'vitest'
import {
  deserializeProject,
  getPassageNeighbors,
  serializeProject,
  validateMaze,
  type MazeProject,
} from '../../core/maze'
import { buildFluidLayout } from '../waterSimulation/freeSurface/layout'
import {
  WATER_STUDIO_PRESETS,
  createWaterStudioProject,
  generateWaterStudioProject,
} from './presets'

function expectGravityDrainage(project: MazeProject): void {
  const graph = project.mazeGraph
  // Reverse traversal from the drain: allowing up/sideways here proves that
  // every cell can drain down/sideways without requiring water to climb a wall.
  const outlet = project.endCell.row * graph.cols + project.endCell.col
  const reached = new Set([outlet])
  const queue = [graph.cells[outlet]]
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]
    for (const { cell: neighbor } of getPassageNeighbors(graph, cell)) {
      if (neighbor.row > cell.row || reached.has(neighbor.index)) continue
      reached.add(neighbor.index)
      queue.push(neighbor)
    }
  }
  const trapped = graph.cells.filter(cell => cell.active && !reached.has(cell.index))
  expect(trapped.map(cell => [cell.row, cell.col]), `${graph.rows}×${graph.cols}, ${graph.seed}`).toEqual([])
}

describe('water studio projects', () => {
  it.each(WATER_STUDIO_PRESETS)('$name has a real top inlet and bottom drain with no trapped regions', preset => {
    for (const seed of ['first', 'second', 'water-studio']) {
      const project = createWaterStudioProject(preset.id, seed)
      expect(validateMaze(project.mazeGraph, project.startCell, project.endCell).valid).toBe(true)
      expect(project.startCell.row).toBe(0)
      expect(project.endCell.row).toBe(project.grid.rows - 1)
      expect(project.mask.cells).toEqual(project.mazeGraph.cells.map(cell => cell.active))
      expectGravityDrainage(project)
      const layout = buildFluidLayout(project)
      expect(layout.inletX).toBe(project.startCell.col + 0.5)
      expect(layout.outletX).toBe(project.endCell.col + 0.5)
      expect(layout.outletY).toBe(project.grid.rows)
    }
  })

  it.each(WATER_STUDIO_PRESETS)('$name remains drainable when resized', preset => {
    for (const size of [{ rows: 4, cols: 4 }, { rows: 7, cols: 9 }, { rows: 12, cols: 12 }, { rows: 24, cols: 24 }]) {
      const project = createWaterStudioProject(preset.id, 'resize', size)
      expect(project.grid.rows).toBe(size.rows)
      expect(project.grid.cols).toBe(size.cols)
      expect(validateMaze(project.mazeGraph, project.startCell, project.endCell).valid).toBe(true)
      expectGravityDrainage(project)
    }
  })

  it('retains an editable, exportable garden mask with physical islands', () => {
    const project = createWaterStudioProject('garden')
    expect(project.mask.cells.filter(active => !active)).toHaveLength(4)
    const restored = deserializeProject(serializeProject(project))
    expect(restored.mazeGraph).toEqual(project.mazeGraph)
    expect(restored.startCell).toEqual(project.startCell)
    expect(restored.endCell).toEqual(project.endCell)
    expectGravityDrainage(restored)
  })

  it('reproduces seeded geometry while creating independent project copies', () => {
    const first = createWaterStudioProject('cascade', 'fixed')
    const second = createWaterStudioProject('cascade', 'fixed')
    expect(first.mazeGraph).toEqual(second.mazeGraph)
    expect(first.mazeGraph.cells[0]).not.toBe(second.mazeGraph.cells[0])
    const layouts = new Set(Array.from({ length: 10 }, (_, index) => JSON.stringify(
      createWaterStudioProject('cascade', `variation-${index}`).mazeGraph.cells,
    )))
    expect(layouts.size).toBeGreaterThan(3)
  })

  it('keeps atelier variations reproducible with branched chambers and physical islands', () => {
    const first = createWaterStudioProject('atelier', 'atelier-01')
    const second = createWaterStudioProject('atelier', 'atelier-01')
    expect(first.grid.rows).toBe(10)
    expect(first.grid.cols).toBe(10)
    expect(first.mazeGraph).toEqual(second.mazeGraph)
    expect(first.mazeGraph.cells[0]).not.toBe(second.mazeGraph.cells[0])
    expect(first.mask.cells.filter(active => !active)).toHaveLength(2)
    expect(deserializeProject(serializeProject(first)).mazeGraph).toEqual(first.mazeGraph)
    for (let seed = 0; seed < 24; seed++) {
      const project = createWaterStudioProject('atelier', `atelier-variant-${seed}`)
      const graph = project.mazeGraph
      // Real junctions and pockets retain multiple flow routes around the
      // islands; the curated shape is not just one unbranched corridor.
      const junctions = graph.cells.filter(cell => getPassageNeighbors(graph, cell).length >= 3)
      expect(junctions.length).toBeGreaterThanOrEqual(graph.cells.length / 5)
      expectGravityDrainage(project)
    }
  })

  it('keeps chamber gates connected at every supported height and representative widths', () => {
    for (let rows = 4; rows <= 24; rows++) {
      for (const cols of [4, 8, 10, 12, 24]) {
        const project = createWaterStudioProject('atelier', `height-${rows}-${cols}`, { rows, cols })
        expectGravityDrainage(project)
        expect(validateMaze(project.mazeGraph, project.startCell, project.endCell).valid).toBe(true)
      }
    }
  })

  it('creates varied random layouts that all drain by gravity', () => {
    const layouts = new Set<string>()
    for (let seed = 0; seed < 10; seed++) {
      const project = generateWaterStudioProject(8, 8, `random-${seed}`)
      expectGravityDrainage(project)
      expect(validateMaze(project.mazeGraph, project.startCell, project.endCell).valid).toBe(true)
      layouts.add(JSON.stringify(project.mazeGraph.cells))
    }
    expect(layouts.size).toBe(10)
    expect(generateWaterStudioProject(6, 7, 'fixed').mazeGraph).toEqual(generateWaterStudioProject(6, 7, 'fixed').mazeGraph)
  })

  it.each(WATER_STUDIO_PRESETS)('$name changes geometry when given fresh seeds', preset => {
    const layouts = new Set(Array.from({ length: 12 }, (_, index) => JSON.stringify(
      createWaterStudioProject(preset.id, `variation-${index}`).mazeGraph.cells,
    )))
    expect(layouts.size).toBeGreaterThan(1)
  })

  it('rejects unusable or excessive dimensions before building simulation geometry', () => {
    for (const size of [{ rows: 3, cols: 8 }, { rows: 8.5, cols: 8 }, { rows: 8, cols: 25 }]) {
      expect(() => createWaterStudioProject('cascade', 'size', size)).toThrow(RangeError)
      expect(() => generateWaterStudioProject(size.rows, size.cols)).toThrow(RangeError)
    }
  })
})
