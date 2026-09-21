import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createEmptyGraph } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { buildFluidLayout } from './layout'
import { ceramicWallGeometry, ceramicWallShapes } from './ceramicWalls'

describe('continuous ceramic wall sculpture', () => {
  it('unions an overlapping T junction into one rounded perimeter, without internal faces', () => {
    const shapes = ceramicWallShapes([
      { x0: -0.075, x1: 3.075, y0: -0.075, y1: 0.075 },
      { x0: 0.925, x1: 1.075, y0: -0.075, y1: 2.075 },
    ])
    expect(shapes).toHaveLength(1)
    expect(shapes[0].holes).toHaveLength(0)
    expect(shapes[0].curves.some(curve => curve.type === 'CubicBezierCurve')).toBe(true)
    const mesh = new THREE.Mesh(ceramicWallGeometry([
      { x0: -0.075, x1: 3.075, y0: -0.075, y1: 0.075 },
      { x0: 0.925, x1: 1.075, y0: -0.075, y1: 2.075 },
    ]), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    // A ray through the old intersection crosses only the union's two sides.
    const hits = new THREE.Raycaster(new THREE.Vector3(1, -0.055, 0.24), new THREE.Vector3(1, 0, 0)).intersectObject(mesh)
    expect(hits).toHaveLength(1)
    expect(hits[0].point.x).toBeGreaterThan(3)
    mesh.geometry.dispose(); mesh.material.dispose()
  })

  it('retains closed channels, separate mask islands, and the actual entrance and exit', () => {
    const graph = createEmptyGraph(6, 6)
    graph.cells.forEach(cell => { cell.active = (cell.row < 4 && cell.col < 4) || (cell.row === 5 && cell.col === 5) })
    const layout = buildFluidLayout(createTestProject({ mazeGraph: graph, endCell: { row: 3, col: 3 } }))
    const before = JSON.stringify(layout.walls)
    const shapes = ceramicWallShapes(layout.walls)
    expect(shapes.length).toBeGreaterThanOrEqual(2)
    expect(shapes.reduce((n, shape) => n + shape.holes.length, 0)).toBeGreaterThan(10)
    const geometry = ceramicWallGeometry(layout.walls)
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geometry, material)
    const isCovered = (x: number, y: number) => new THREE.Raycaster(new THREE.Vector3(x, -y, 2), new THREE.Vector3(0, 0, -1)).intersectObject(mesh).length > 0
    expect(isCovered(layout.inletX, layout.topY)).toBe(false)
    expect(isCovered(layout.outletX, layout.outletY)).toBe(false)
    for (const cell of graph.cells.filter(cell => cell.active)) expect(isCovered(cell.col + 0.5, cell.row + 0.5)).toBe(false)
    expect(isCovered(2, 2.5)).toBe(true)
    expect(isCovered(4.5, 4.5)).toBe(false)
    expect(JSON.stringify(layout.walls)).toBe(before)
    expect(geometry.boundingBox!.min.z).toBeCloseTo(0)
    expect(geometry.boundingBox!.max.z).toBeCloseTo(0.48)
    const normals = geometry.getAttribute('normal')
    for (let i = 0; i < normals.count; i++) expect(Number.isFinite(normals.getX(i) + normals.getY(i) + normals.getZ(i))).toBe(true)
    geometry.dispose(); material.dispose()
  })

  it('ignores the independently rendered funnel and accepts an empty network', () => {
    expect(ceramicWallShapes([{ x0: 0, x1: 1, y0: 0, y1: 1, kind: 'funnel' }])).toEqual([])
    const geometry = ceramicWallGeometry([])
    expect(geometry.getAttribute('position').count).toBe(0)
    geometry.dispose()
  })
})
