import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createEmptyGraph } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { buildFluidLayout } from './layout'
import { FreeSurfacePresentation3D } from './presentation3d'

describe('visual maze look controls', () => {
  it('preserves the sculpted network, terrace profile and field texture across look edits', () => {
    const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(6, 6) }))
    const texture = new THREE.Texture()
    const board = new FreeSurfacePresentation3D(layout, texture)
    const walls = board.content.getObjectByName('extruded-maze-walls') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial[]>
    const field = board.content.getObjectByName('physical-displaced-water') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
    const geometry = walls.geometry
    const positions = geometry.getAttribute('position').array.slice()
    const solverWalls = JSON.stringify(layout.walls)
    const wallShader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>', fragmentShader: '' }
    walls.material[0].onBeforeCompile(wallShader as never, {} as THREE.WebGLRenderer)
    const terraceKnots = wallShader.uniforms.uTerraceKnots.value
    expect(wallShader.uniforms.uCeramicHeight.value).toBe(1)
    expect(wallShader.vertexShader).toContain('position.z * uCeramicHeight + terraceElevation(position.y)')
    expect(geometry.groups).toHaveLength(2)
    expect(geometry.getAttribute('aCeramicSlope').count).toBe(geometry.getAttribute('position').count)
    board.setLook({ theme: 'glacier', light: 'golden', wallHeight: 1.6 })
    expect(walls.geometry).toBe(geometry)
    expect(geometry.getAttribute('position').array).toEqual(positions)
    expect(JSON.stringify(layout.walls)).toBe(solverWalls)
    expect(wallShader.uniforms.uCeramicHeight.value).toBeCloseTo(1.6)
    expect(wallShader.uniforms.uTerraceKnots.value).toBe(terraceKnots)
    expect(walls.scale.z).toBe(1)
    const depthShader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '' }
    walls.customDepthMaterial!.onBeforeCompile(depthShader as never, {} as THREE.WebGLRenderer)
    expect(depthShader.uniforms.uCeramicHeight).toBe(wallShader.uniforms.uCeramicHeight)
    expect(depthShader.vertexShader).toContain('position.z * uCeramicHeight + terraceElevation(position.y)')
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '', fragmentShader: '' }
    field.material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer)
    expect(shader.uniforms.uLiquid.value).toBe(texture)
    expect(field.material.transmission).toBeGreaterThan(0.9)
    expect(board.content.getObjectByName('extruded-maze-walls')).toBe(walls)
    board.dispose()
  })
})
