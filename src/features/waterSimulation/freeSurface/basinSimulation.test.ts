import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createEmptyGraph } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { createWaterStudioProject } from '../../waterStudio/presets'
import { BASIN_FLOOR_Z, BASIN_INITIAL_DEPTH, BASIN_OUTLET_SILL_DEPTH, BasinSimulation } from './basinSimulation'
import { BasinField } from './basinField'
import { BasinFixtures } from './basinFixtures'
import { buildFluidLayout } from './layout'

const createBasin = () => {
  const project = createTestProject()
  return new BasinSimulation(project, buildFluidLayout(project))
}

describe('physical horizontal basin', () => {
  it('accounts for its actual initial water instead of inventing a full render mask', () => {
    const basin = createBasin(), snapshot = basin.snapshot()
    expect(snapshot.depth.length).toBe(4)
    for (const depth of snapshot.depth) expect(depth).toBeCloseTo(BASIN_INITIAL_DEPTH)
    expect(snapshot.initialStoredVolume).toBeCloseTo(4 * 0.86 * BASIN_INITIAL_DEPTH)
    expect(snapshot.diagnostics.stored).toBeCloseTo(snapshot.initialStoredVolume)
    expect(snapshot.diagnostics.injected).toBe(0)
    expect(snapshot.diagnostics.massError).toBeLessThan(1e-12)
  })

  it('sustains conserved flow through the middle of the default atelier at its default inflow', () => {
    const project = createWaterStudioProject('atelier', 'atelier-01')
    const basin = new BasinSimulation(project, buildFluidLayout(project))
    const { network, state } = basin.solver
    const middleRow = Math.floor(network.rows / 2)
    const crossingEdges: { edge: number; direction: number }[] = []
    for (let edge = 0; edge < network.edgeCount; edge++) {
      const from = network.nodeRow[network.edgeFrom[edge]], to = network.nodeRow[network.edgeTo[edge]]
      if (from < middleRow && to >= middleRow) crossingEdges.push({ edge, direction: 1 })
      else if (to < middleRow && from >= middleRow) crossingEdges.push({ edge, direction: -1 })
    }
    expect(crossingEdges.length).toBeGreaterThan(0)
    let previous = { injected: 0, discharged: 0, transit: 0 }
    for (const seconds of [5, 10]) {
      for (let step = 0; step < 20; step++) basin.advance(0.25, 0.65)
      const snapshot = basin.snapshot(), d = snapshot.diagnostics
      // Initial water at the outlet can drain without traversing the maze.
      // Signed transfer through this interior cut must also keep increasing.
      const transit = crossingEdges.reduce((sum, { edge, direction }) => sum + state.cumulativeSignedVolume[edge] * direction, 0)
      const flow = crossingEdges.reduce((sum, { edge, direction }) => sum + state.discharge[edge] * direction, 0)
      expect(d.time).toBeCloseTo(seconds, 8)
      expect(d.injected - previous.injected).toBeGreaterThan(0.1)
      expect(d.discharged - previous.discharged).toBeGreaterThan(0.1)
      expect(transit - previous.transit).toBeGreaterThan(0.05)
      expect(flow).toBeGreaterThan(0.02)
      expect(snapshot.sourceRate).toBeGreaterThan(0.02)
      expect(d.outletRate).toBeGreaterThan(0.02)
      expect(d.escaped).toBe(0)
      expect(d.stored).toBeCloseTo(snapshot.initialStoredVolume + d.injected - d.discharged, 9)
      expect(d.massError).toBeLessThan(1e-9)
      previous = { injected: d.injected, discharged: d.discharged, transit }
    }
  })

  it('drains through the actual raised outlet while preserving retained water and total mass', () => {
    const basin = createBasin(), start = basin.snapshot().diagnostics.stored
    for (let i = 0; i < 240; i++) basin.advance(0.25, 0)
    const snapshot = basin.snapshot()
    expect(snapshot.diagnostics.stored).toBeLessThan(start * 0.78)
    expect(snapshot.diagnostics.discharged).toBeGreaterThan(0.1)
    expect(snapshot.diagnostics.injected).toBe(0)
    expect(snapshot.sourceRate).toBe(0)
    expect(snapshot.diagnostics.massError).toBeLessThan(1e-9)
    const outlet = basin.solver.network.nodeCellIndex[basin.solver.network.outletNode]
    expect(snapshot.depth[outlet]).toBeGreaterThanOrEqual(BASIN_OUTLET_SILL_DEPTH - 0.005)
    expect(snapshot.diagnostics.stored).toBeGreaterThan(4 * 0.86 * BASIN_OUTLET_SILL_DEPTH * 0.95)
  })

  it('does not fill isolated cells behind closed walls and retains their portal topology', () => {
    const project = createTestProject({ mazeGraph: createEmptyGraph(2, 2), startCell: { row: 0, col: 0 }, endCell: { row: 1, col: 1 } })
    const basin = new BasinSimulation(project, buildFluidLayout(project))
    for (let i = 0; i < 40; i++) basin.advance(0.25, 2.5)
    const snapshot = basin.snapshot()
    expect(snapshot.depth[0]).toBeGreaterThan(BASIN_INITIAL_DEPTH)
    expect([...snapshot.depth.slice(1)]).toEqual([0, 0, 0])
    expect([...snapshot.connections]).toEqual([0, 0, 0, 0])
    expect(snapshot.diagnostics.massError).toBeLessThan(1e-9)
  })

  it('keeps water below the minimum wall and restores initial mass and time on reset', () => {
    const basin = createBasin()
    basin.setWallHeight(0.55)
    for (let i = 0; i < 400; i++) basin.advance(0.25, 2.5)
    let snapshot = basin.snapshot()
    expect(Math.max(...snapshot.depth) + BASIN_FLOOR_Z).toBeLessThanOrEqual(1.05 * 0.55 - 0.10 + 1e-6)
    expect(snapshot.diagnostics.massError).toBeLessThan(1e-8)
    expect(snapshot.diagnostics.injected).toBeGreaterThan(0)
    basin.reset()
    snapshot = basin.snapshot()
    expect(snapshot.diagnostics.time).toBe(0)
    expect(snapshot.diagnostics.injected).toBe(0)
    expect(snapshot.diagnostics.discharged).toBe(0)
    for (const depth of snapshot.depth) expect(depth).toBeCloseTo(BASIN_INITIAL_DEPTH)
  })

  it('copies simulation depth and links into a field instead of retaining mutable snapshot buffers', () => {
    const basin = createBasin(), snapshot = basin.snapshot()
    const field = new BasinField(snapshot.rows, snapshot.cols)
    field.update(snapshot)
    const data = field.texture.image.data as Float32Array
    expect(data[0]).toBeCloseTo(BASIN_INITIAL_DEPTH)
    expect(data[3]).toBe(16 + snapshot.connections[0])
    snapshot.depth[0] = 0
    expect(data[0]).toBeCloseTo(BASIN_INITIAL_DEPTH)
    field.dispose()
  })

  it('keeps the inlet pipe over the tallest rim and its jet joined to both nozzle and water', () => {
    const project = createTestProject(), layout = buildFluidLayout(project)
    const basin = new BasinSimulation(project, layout), fixtures = new BasinFixtures(layout)
    basin.advance(0.25, 1)
    const snapshot = basin.snapshot()
    fixtures.update(snapshot)
    const foot = fixtures.group.getObjectByName('basin-supply-foot')!
    const footPosition = foot.position.clone()
    const pipe = fixtures.group.getObjectByName('basin-supply-pipe') as THREE.Mesh
    const opening = fixtures.group.getObjectByName('basin-supply-opening')!
    const jet = fixtures.group.getObjectByName('supply-glint')!
    for (const height of [1.75, 0.55, 1.75]) {
      fixtures.setWallHeight(height)
      fixtures.group.updateMatrixWorld(true)
      const rim = height * 1.05 + 0.014
      const positions = pipe.geometry.getAttribute('position')
      let crossingVertices = 0
      for (let i = 0; i < positions.count; i++) {
        if (Math.abs(positions.getY(i) + layout.topY) > 0.14) continue
        crossingVertices++
        expect(positions.getZ(i)).toBeGreaterThan(rim)
      }
      expect(crossingVertices).toBeGreaterThan(0)
      const bounds = new THREE.Box3().setFromObject(jet)
      expect(bounds.max.z).toBeCloseTo(opening.position.z, 6)
      expect(bounds.min.z).toBeCloseTo(snapshot.depth[layout.topY * layout.cols + Math.floor(layout.inletX)] + BASIN_FLOOR_Z, 6)
      expect(bounds.max.y).toBeLessThan(-layout.topY - 0.14)
      expect(foot.position.equals(footPosition)).toBe(true)
    }
    fixtures.dispose()
  })
})
