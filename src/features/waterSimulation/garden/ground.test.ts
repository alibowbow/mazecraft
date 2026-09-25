import { describe, expect, it } from 'vitest'
import type { GardenField } from './flowField'
import { sandDistances } from './ground'

function fieldWith(width: number, height: number, inside: (x: number, y: number) => boolean): GardenField {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 2] = inside(x, y) ? 0 : 200
  return { data, width, height, bounds: [0, 0, width * 0.1, height * 0.1], cell: 0.1, entry: new Float32Array(0), wettingOrder: [], outletKey: new Float32Array(0) }
}

describe('raked sand distances', () => {
  it('measures exact Euclidean distance to the footprint', () => {
    const field = fieldWith(40, 30, (x, y) => x === 10 && y === 10)
    const distance = sandDistances(field)
    expect(distance[10 * 40 + 10]).toBe(0)
    expect(distance[10 * 40 + 13]).toBeCloseTo(0.3, 5)
    expect(distance[14 * 40 + 13]).toBeCloseTo(0.5, 5)
    expect(distance[29 * 40 + 39]).toBeCloseTo(Math.hypot(29, 19) * 0.1, 4)
  })

  it('rakes around islands on the sand', () => {
    const field = fieldWith(40, 30, () => false)
    const distance = sandDistances(field, [[2, 1.5, 0.4]])
    // Cell centres sit half a cell off the grid lines.
    expect(distance[15 * 40 + 20]).toBeCloseTo(Math.max(0, Math.hypot(0.05, 0.05) - 0.4), 5)
    expect(distance[15 * 40 + 30]).toBeCloseTo(Math.hypot(1.05, 0.05) - 0.4, 5)
  })
})
