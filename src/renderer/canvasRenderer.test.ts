import { describe, expect, it } from 'vitest'
import { interpolatePathProgress } from './canvasRenderer'

describe('interpolatePathProgress', () => {
  const path = [
    { row: 0, col: 0 },
    { row: 0, col: 1 },
    { row: 1, col: 1 },
  ]

  it('starts at the first cell and interpolates inside the active segment', () => {
    expect(interpolatePathProgress(path, 0)).toEqual([{ row: 0, col: 0 }])
    expect(interpolatePathProgress(path, 0.25)).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 0.5 },
    ])
    expect(interpolatePathProgress(path, 0.75)).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0.5, col: 1 },
    ])
  })

  it('clamps progress and includes the exact end cell at completion', () => {
    expect(interpolatePathProgress(path, -1)).toEqual([{ row: 0, col: 0 }])
    expect(interpolatePathProgress(path, 2)).toEqual(path)
  })
})
