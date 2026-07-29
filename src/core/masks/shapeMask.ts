import { createMaskFromPredicate } from '../maze/graph'
import type { BasicShapeName, MazeMask } from '../maze/types'
import type { BooleanMask } from './types'

interface Point {
  x: number
  y: number
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const left = polygon[current]
    const right = polygon[previous]
    const crosses =
      left.y > point.y !== right.y > point.y &&
      point.x <
        ((right.x - left.x) * (point.y - left.y)) / (right.y - left.y) + left.x
    if (crosses) inside = !inside
  }
  return inside
}

function regularStar(points = 5): Point[] {
  const vertices: Point[] = []
  for (let index = 0; index < points * 2; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI) / points
    const radius = index % 2 === 0 ? 1 : 0.43
    vertices.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  }
  return vertices
}

const STAR = regularStar()

function inRoundedRectangle(x: number, y: number, radius = 0.22): boolean {
  const halfWidth = 1
  const halfHeight = 0.82
  const qx = Math.abs(x) - (halfWidth - radius)
  const qy = Math.abs(y) - (halfHeight - radius)
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
      Math.min(Math.max(qx, qy), 0) <=
    radius
  )
}

function shapePredicate(shape: BasicShapeName, x: number, y: number): boolean {
  switch (shape) {
    case 'rectangle':
      return Math.abs(x) <= 1 && Math.abs(y) <= 0.82
    case 'rounded-rectangle':
      return inRoundedRectangle(x, y)
    case 'circle':
      return x * x + y * y <= 0.92 * 0.92
    case 'ellipse':
      return x * x + (y * y) / (0.68 * 0.68) <= 1
    case 'heart': {
      const hx = x * 1.08
      const hy = -(y + 0.12) * 1.08
      const base = hx * hx + hy * hy - 1
      return base * base * base - hx * hx * hy * hy * hy <= 0
    }
    case 'star':
      return pointInPolygon({ x, y }, STAR)
    case 'diamond':
      return Math.abs(x) + Math.abs(y) <= 1
    case 'hexagon':
      return Math.abs(y) <= 0.86 && Math.sqrt(3) * Math.abs(x) + Math.abs(y) <= 1.72
    case 'crescent': {
      const outer = x * x + y * y <= 0.9 * 0.9
      const inner = (x - 0.38) ** 2 + (y + 0.02) ** 2 <= 0.75 * 0.75
      return outer && !inner
    }
    case 'cloud':
      return (
        (x + 0.5) ** 2 + (y + 0.03) ** 2 <= 0.43 ** 2 ||
        (x + 0.12) ** 2 + (y + 0.25) ** 2 <= 0.48 ** 2 ||
        (x - 0.3) ** 2 + (y + 0.2) ** 2 <= 0.52 ** 2 ||
        (x - 0.62) ** 2 + (y + 0.02) ** 2 <= 0.38 ** 2 ||
        (Math.abs(x) <= 0.72 && y >= -0.08 && y <= 0.43)
      )
    case 'flower': {
      if (x * x + y * y <= 0.3 ** 2) return true
      for (let index = 0; index < 6; index += 1) {
        const angle = (index * Math.PI) / 3
        const px = Math.cos(angle) * 0.57
        const py = Math.sin(angle) * 0.57
        if ((x - px) ** 2 / 0.42 ** 2 + (y - py) ** 2 / 0.34 ** 2 <= 1) {
          return true
        }
      }
      return false
    }
    case 'tree':
      return (
        (y > 0.35 && Math.abs(x) <= 0.18) ||
        pointInPolygon(
          { x, y },
          [
            { x: 0, y: -1 },
            { x: -0.78, y: 0.5 },
            { x: 0.78, y: 0.5 },
          ],
        )
      )
    case 'house':
      return (
        (Math.abs(x) <= 0.7 && y >= -0.05 && y <= 0.85) ||
        pointInPolygon(
          { x, y },
          [
            { x: -0.88, y: -0.04 },
            { x: 0, y: -0.88 },
            { x: 0.88, y: -0.04 },
          ],
        )
      )
    case 'crown':
      return pointInPolygon(
        { x, y },
        [
          { x: -0.92, y: -0.58 },
          { x: -0.48, y: -0.12 },
          { x: -0.22, y: -0.72 },
          { x: 0, y: -0.08 },
          { x: 0.28, y: -0.74 },
          { x: 0.52, y: -0.1 },
          { x: 0.94, y: -0.58 },
          { x: 0.76, y: 0.7 },
          { x: -0.76, y: 0.7 },
        ],
      )
    case 'lightning':
      return pointInPolygon(
        { x, y },
        [
          { x: 0.1, y: -1 },
          { x: -0.62, y: 0.08 },
          { x: -0.08, y: 0.08 },
          { x: -0.3, y: 1 },
          { x: 0.72, y: -0.24 },
          { x: 0.18, y: -0.24 },
        ],
      )
    case 'speech-bubble':
      return (
        inRoundedRectangle(x, y + 0.12, 0.25) ||
        pointInPolygon(
          { x, y },
          [
            { x: -0.42, y: 0.48 },
            { x: -0.72, y: 0.98 },
            { x: -0.04, y: 0.52 },
          ],
        )
      )
    case 'puzzle': {
      const base = Math.abs(x) <= 0.78 && Math.abs(y) <= 0.78
      const topKnob = x * x + (y + 0.78) ** 2 <= 0.27 ** 2
      const rightKnob = (x - 0.78) ** 2 + y * y <= 0.27 ** 2
      const leftCutout = (x + 0.78) ** 2 + y * y < 0.26 ** 2
      return (base || topKnob || rightKnob) && !leftCutout
    }
  }
}

export function createBasicShapeMask(
  shape: BasicShapeName,
  rows: number,
  cols: number,
  inset = 0.04,
): MazeMask {
  const scale = 1 / Math.max(0.1, 1 - Math.min(0.45, Math.max(0, inset)))
  return createMaskFromPredicate(rows, cols, ({ row, col }) => {
    const x = (((col + 0.5) / cols) * 2 - 1) * scale
    const y = (((row + 0.5) / rows) * 2 - 1) * scale
    return shapePredicate(shape, x, y)
  })
}

/** Matrix-shaped compatibility API used by Canvas mask editors. */
export function createShapeMask(
  shape: BasicShapeName,
  rows: number,
  cols: number,
  inset = 0.04,
): BooleanMask {
  const mask = createBasicShapeMask(shape, rows, cols, inset)
  return Array.from({ length: rows }, (_, row) =>
    mask.cells.slice(row * cols, (row + 1) * cols),
  )
}
