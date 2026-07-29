import { describe, expect, it } from 'vitest'
import { createShapeMask } from './shapeMask'

describe('shape masks', () => {
  it('creates a centered circle without activating its corners', () => {
    const mask = createShapeMask('circle', 20, 20)
    expect(mask[10][10]).toBe(true)
    expect(mask[0][0]).toBe(false)
    expect(mask.flat().filter(Boolean).length).toBeGreaterThan(200)
  })

  it('supports every built-in vector silhouette', () => {
    const shapes = [
      'rectangle',
      'rounded-rectangle',
      'circle',
      'ellipse',
      'heart',
      'star',
      'diamond',
      'hexagon',
      'crescent',
      'cloud',
      'flower',
      'tree',
      'house',
      'crown',
      'lightning',
      'speech-bubble',
      'puzzle',
    ] as const
    shapes.forEach((shape) => {
      const mask = createShapeMask(shape, 24, 24)
      expect(mask.flat().some(Boolean)).toBe(true)
    })
  })
})
