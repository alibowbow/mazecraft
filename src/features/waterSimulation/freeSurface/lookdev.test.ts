import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createEmptyGraph } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { buildFluidLayout } from './layout'
import { FreeSurfacePresentation3D } from './presentation3d'

describe('visual maze look controls', () => {
  it('preserves wall footprints and field texture across theme and height changes', () => {
    const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(6, 6) }))
    const texture = new THREE.Texture()
    const board = new FreeSurfacePresentation3D(layout, texture)
    const walls = board.content.getObjectByName('extruded-maze-walls') as THREE.InstancedMesh
    const field = board.content.getObjectByName('continuous-free-surface') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
    const before = new THREE.Matrix4()
    walls.getMatrixAt(0, before)
    const physicalWalls = layout.walls.filter(wall => wall.kind !== 'funnel')
    expect(walls.count).toBeLessThan(physicalWalls.length)
    const visibleWalls = Array.from({ length: walls.count }, (_, index) => {
      const transform = new THREE.Matrix4()
      walls.getMatrixAt(index, transform)
      const m = transform.elements
      return { x0: m[12] - m[0] / 2, x1: m[12] + m[0] / 2, y0: -m[13] - m[5] / 2, y1: -m[13] + m[5] / 2 }
    })
    const covered = (rectangles: typeof visibleWalls, x: number, y: number) => rectangles.some(rect => x > rect.x0 && x < rect.x1 && y > rect.y0 && y < rect.y1)
    for (let row = 0; row <= 12; row++) for (let col = 0; col <= 12; col++) {
      expect(covered(visibleWalls, col / 2 + 0.013, row / 2 + 0.017))
        .toBe(covered(physicalWalls, col / 2 + 0.013, row / 2 + 0.017))
    }
    board.setLook({ theme: 'glacier', light: 'golden', wallHeight: 1.6 })
    const after = new THREE.Matrix4()
    walls.getMatrixAt(0, after)
    expect(after.elements[0]).toBe(before.elements[0])
    expect(after.elements[5]).toBe(before.elements[5])
    expect(after.elements[12]).toBe(before.elements[12])
    expect(after.elements[13]).toBe(before.elements[13])
    expect(after.elements[10] / before.elements[10]).toBeCloseTo(1.6, 5)
    expect(field.material.uniforms.uField.value).toBe(texture)
    expect(board.content.getObjectByName('extruded-maze-walls')).toBe(walls)
    board.dispose()
  })
})
