import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createGeneratedWaterMaze, DEFAULT_WATER_MAZE } from '../../waterStudio/createMaze'
import { buildFluidLayout } from './layout'
import { mazeBodyShapes, SculptedSurface } from './sculptedSurface'

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

})
