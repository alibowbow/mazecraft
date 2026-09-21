import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createGeneratedWaterMaze, DEFAULT_WATER_MAZE } from '../../waterStudio/createMaze'
import { buildFluidLayout } from './layout'
import { mazeBodyShapes, SculptedSurface } from './sculptedSurface'
import { AQUA_WATER_APPEARANCE, DEFAULT_WATER_APPEARANCE } from './appearance'

describe('sculpted maze body', () => {
  it('builds a closed solid body with the original active-cell silhouette', () => {
    const project = createGeneratedWaterMaze(DEFAULT_WATER_MAZE)
    const layout = buildFluidLayout(project)
    const shapes = mazeBodyShapes(layout)
    expect(shapes).toHaveLength(1)
    expect(Math.abs(THREE.ShapeUtils.area(shapes[0].getPoints()))).toBe(144)
    const surface = new SculptedSurface(layout, new THREE.Texture(), new THREE.Vector4(-1, -15, 15, 19))
    expect(surface.body.geometry.attributes.position.count).toBeGreaterThan(100)
    expect(surface.water.geometry.attributes.position.count).toBeGreaterThan(1000)
    surface.dispose()
  })
  it('retains a heart silhouette instead of covering inactive cells with a rectangle', () => {
    const project = createGeneratedWaterMaze({ ...DEFAULT_WATER_MAZE, shape: 'heart', rows: 16, cols: 16 })
    const layout = buildFluidLayout(project)
    const area = mazeBodyShapes(layout).reduce((sum, shape) => sum + Math.abs(THREE.ShapeUtils.area(shape.getPoints())) - shape.holes.reduce((n, h) => n + Math.abs(THREE.ShapeUtils.area(h.getPoints())), 0), 0)
    expect(area).toBe(layout.activeCellCount)
    expect(area).toBeLessThan(256)
  })
  it('separates diagonal mask islands into simple outlines', () => {
    const layout = buildFluidLayout(createGeneratedWaterMaze(DEFAULT_WATER_MAZE))
    const shapes = mazeBodyShapes({ ...layout, rows: 2, cols: 2, activeCells: new Uint8Array([1, 0, 0, 1]) })
    expect(shapes).toHaveLength(2)
    expect(shapes.map(shape => Math.abs(THREE.ShapeUtils.area(shape.getPoints())))).toEqual([1, 1])
  })

  it('casts one substantial body above the studio ground without a second visible board', () => {
    const layout = buildFluidLayout(createGeneratedWaterMaze(DEFAULT_WATER_MAZE))
    const surface = new SculptedSurface(layout, new THREE.Texture(), new THREE.Vector4(-1, -15, 15, 19))
    surface.body.geometry.computeBoundingBox()
    const bounds = surface.body.geometry.boundingBox!
    expect(bounds.min.z).toBeGreaterThan(-0.7)
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(0.6)
    expect(surface.foundation.visible).toBe(false)
    surface.dispose()
  })

  it('restores neutral clear absorption after a colored appearance and shares the supplied clock', () => {
    const layout = buildFluidLayout(createGeneratedWaterMaze(DEFAULT_WATER_MAZE))
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1)
    const surface = new SculptedSurface(layout, texture, new THREE.Vector4(-1, -15, 15, 19))
    surface.setAppearance(AQUA_WATER_APPEARANCE)
    expect(surface.waterMaterial.attenuationColor.g).toBeGreaterThan(surface.waterMaterial.attenuationColor.r)
    surface.setAppearance(DEFAULT_WATER_APPEARANCE)
    const clear = surface.waterMaterial.attenuationColor
    expect(clear.r).toBe(clear.g)
    expect(clear.g).toBe(clear.b)
    expect(surface.waterMaterial.color.getHex()).toBe(0xffffff)
    surface.update(4.2, 0.6)
    surface.update(4.2, 0.6)
    expect(surface.uniforms.uLiquidTime.value).toBe(4.2)
    surface.dispose()
    texture.dispose()
  })

})
