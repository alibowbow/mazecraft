import type { BooleanMask, DrawingPoint } from './types'

export const createDrawingMask = (
  strokes: DrawingPoint[][],
  rows: number,
  cols: number,
  brushRadius = 0.035,
): BooleanMask => {
  const mask = Array.from({ length: rows }, () => Array(cols).fill(false))
  const radiusSquared = brushRadius ** 2
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = (col + 0.5) / cols
      const y = (row + 0.5) / rows
      mask[row][col] = strokes.some((stroke) =>
        stroke.some((point) => (x - point.x) ** 2 + (y - point.y) ** 2 <= radiusSquared * (point.pressure ?? 1)),
      )
    }
  }
  return mask
}
