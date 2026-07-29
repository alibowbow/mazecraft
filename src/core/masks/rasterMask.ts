import { getCellIndex } from '../maze/graph'
import type { MazeMask } from '../maze/types'

const DELTAS = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
] as const

function maskComponents(mask: MazeMask, target: boolean): number[][] {
  const seen = new Uint8Array(mask.cells.length)
  const components: number[][] = []

  for (let start = 0; start < mask.cells.length; start += 1) {
    if (seen[start] || mask.cells[start] !== target) continue
    const queue = [start]
    const component: number[] = []
    seen[start] = 1
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]
      component.push(index)
      const row = Math.floor(index / mask.cols)
      const col = index % mask.cols
      for (const [rowDelta, colDelta] of DELTAS) {
        const nextRow = row + rowDelta
        const nextCol = col + colDelta
        if (
          nextRow < 0 ||
          nextRow >= mask.rows ||
          nextCol < 0 ||
          nextCol >= mask.cols
        ) {
          continue
        }
        const next = getCellIndex(mask.cols, { row: nextRow, col: nextCol })
        if (!seen[next] && mask.cells[next] === target) {
          seen[next] = 1
          queue.push(next)
        }
      }
    }
    components.push(component)
  }
  return components.sort((left, right) => right.length - left.length)
}
export function keepLargestMaskComponent(mask: MazeMask): MazeMask {
  const largest = maskComponents(mask, true)[0] ?? []
  const cells = new Array<boolean>(mask.cells.length).fill(false)
  for (const index of largest) cells[index] = true
  return { ...mask, cells }
}

export function removeSmallMaskComponents(
  mask: MazeMask,
  minimumCells: number,
): MazeMask {
  const cells = [...mask.cells]
  for (const component of maskComponents(mask, true)) {
    if (component.length < minimumCells) {
      for (const index of component) cells[index] = false
    }
  }
  return { ...mask, cells }
}

export function fillMaskHoles(mask: MazeMask): MazeMask {
  const cells = [...mask.cells]
  for (const component of maskComponents(mask, false)) {
    const touchesBoundary = component.some((index) => {
      const row = Math.floor(index / mask.cols)
      const col = index % mask.cols
      return row === 0 || col === 0 || row === mask.rows - 1 || col === mask.cols - 1
    })
    if (!touchesBoundary) {
      for (const index of component) cells[index] = true
    }
  }
  return { ...mask, cells }
}

export function invertMask(mask: MazeMask): MazeMask {
  return { ...mask, cells: mask.cells.map((cell) => !cell) }
}

export interface RasterMaskOptions {
  threshold?: number
  inverted?: boolean
}

/**
 * Downsamples RGBA pixels into a cell mask. This is pure and worker-safe; image
 * decoding/cropping remains in the browser-facing feature layer.
 */
export function rasterAlphaToMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  rows: number,
  cols: number,
  options: RasterMaskOptions = {},
): MazeMask {
  if (
    width < 1 ||
    height < 1 ||
    rgba.length !== width * height * 4 ||
    rows < 1 ||
    cols < 1
  ) {
    throw new RangeError('Raster dimensions or pixel data are invalid.')
  }
  const threshold = Math.min(255, Math.max(0, options.threshold ?? 128))
  const cells = new Array<boolean>(rows * cols)

  for (let row = 0; row < rows; row += 1) {
    const sourceY = Math.min(height - 1, Math.floor(((row + 0.5) / rows) * height))
    for (let col = 0; col < cols; col += 1) {
      const sourceX = Math.min(width - 1, Math.floor(((col + 0.5) / cols) * width))
      const offset = (sourceY * width + sourceX) * 4
      const luminance =
        rgba[offset] * 0.2126 +
        rgba[offset + 1] * 0.7152 +
        rgba[offset + 2] * 0.0722
      const opaque = rgba[offset + 3] >= threshold
      const dark = luminance <= threshold
      const active = opaque && dark
      cells[row * cols + col] = options.inverted ? !active : active
    }
  }
  return { rows, cols, cells }
}
