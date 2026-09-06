import { describe, expect, it } from 'vitest'
import { createEmptyGraph } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { buildFluidLayout } from './layout'
import { buildSolidMask, WALL_CLEARANCE_SCALE } from './surfaceField'

describe('conservative optical wall clearance', () => {
  it('never skips a solid-mask intersection, including texel corners and non-square masks', () => {
    const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(3, 4) }))
    // A deliberately coarse, non-square mask exercises thin walls, the stepped
    // funnel, and non-integral world-to-texture scaling together.
    const mask = buildSolidMask(layout, 73)
    const [minX, minY, spanX, spanY] = mask.bounds
    const dx = spanX / mask.width, dy = spanY / mask.height
    const solidRects: Array<[number, number, number, number]> = []
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if (mask.data[y * mask.width + x]) {
          solidRects.push([minX + x * dx, minY + y * dy, minX + (x + 1) * dx, minY + (y + 1) * dy])
        }
      }
    }
    let minimumSafetyMargin = Infinity
    let checked = 0
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        const index = y * mask.width + x
        const radius = mask.clearance[index] / 255 * mask.clearanceScale
        if (mask.data[index]) expect(radius).toBe(0)
        if (radius === 0) continue
        // The minimum distance of two rectangles is the infimum over every
        // particle position in this texel, including its boundary corners.
        const x0 = minX + x * dx, x1 = x0 + dx
        const y0 = minY + y * dy, y1 = y0 + dy
        let distance = Infinity
        for (const solid of solidRects) {
          const gapX = Math.max(0, x0 - solid[2], solid[0] - x1)
          const gapY = Math.max(0, y0 - solid[3], solid[1] - y1)
          distance = Math.min(distance, Math.hypot(gapX, gapY))
        }
        minimumSafetyMargin = Math.min(minimumSafetyMargin, distance - radius)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(300)
    expect(minimumSafetyMargin).toBeGreaterThan(0)
    expect(mask.clearanceScale).toBe(WALL_CLEARANCE_SCALE)
    expect(mask.clearance.byteLength).toBe(mask.data.byteLength)
  })

  it('keeps mask samples intact and resolves splat-sized open regions at full range', () => {
    const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(3, 3) }))
    layout.walls = [{ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }]
    const mask = buildSolidMask(layout)
    const [minX, minY, spanX, spanY] = mask.bounds
    const texel = (x: number, y: number) =>
      Math.floor((y - minY) / spanY * mask.height) * mask.width + Math.floor((x - minX) / spanX * mask.width)
    expect(mask.data[texel(0.5, 0.5)]).toBe(255)
    expect(mask.clearance[texel(0.5, 0.5)]).toBe(0)
    expect(mask.data[texel(1.8, 1.8)]).toBe(0)
    expect(mask.clearance[texel(1.8, 1.8)]).toBe(255)
    expect(new Set(mask.data)).toEqual(new Set([0, 255]))
  })
})
