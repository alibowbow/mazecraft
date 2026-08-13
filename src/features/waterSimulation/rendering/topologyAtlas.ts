import type { MazeGraph, WallDirection } from '../../../core/maze'

export interface WaterTopologyAtlasOptions {
  /** Requested static-mask resolution. The value is reduced to fit maxTextureSize. */
  pixelsPerCell?: number
  maxTextureSize?: number
  channelInsetRatio?: number
  sourceCellIndex?: number
  outletCellIndex?: number
  /**
   * Optional solver node order. Pass HydraulicNetwork.nodeCellIndex so atlas
   * CPU mappings and dynamic snapshots cannot silently disagree.
   */
  nodeCellIndices?: Int32Array
}

/**
 * Static RGBA atlas layout:
 * R = channel coverage, G = source mask, B = outlet mask, A = active channel.
 *
 * `texelToActiveIndex` is kept on the CPU for picking/debugging. It is not
 * uploaded every frame. Atlas Y follows WebGL UV coordinates (bottom-up),
 * while maze rows are stored top-down.
 */
export interface WaterTopologyAtlas {
  readonly width: number
  readonly height: number
  readonly pixelsPerCell: number
  readonly data: Uint8Array
  readonly activeCellIndices: Int32Array
  readonly cellToActiveIndex: Int32Array
  readonly texelToActiveIndex: Int32Array
}

/**
 * Counts unique channel-mask texels that touch a closed interior cell portal.
 *
 * A valid atlas leaves both edge rows/columns empty wherever two neighboring
 * cells are not connected by one mutually-open passage. This includes an
 * active cell next to an inactive mask cell. Inspecting both sides makes the
 * diagnostic catch an accidental paint from either cell without depending on
 * the dynamic water state.
 */
export function countClosedWallLeakTexels(
  graph: MazeGraph,
  atlas: WaterTopologyAtlas,
): number {
  assertGraph(graph)
  const pixelsPerCell = atlas.pixelsPerCell
  if (
    !Number.isInteger(pixelsPerCell) ||
    pixelsPerCell < 1 ||
    atlas.width !== graph.cols * pixelsPerCell ||
    atlas.height !== graph.rows * pixelsPerCell ||
    atlas.data.length !== atlas.width * atlas.height * 4
  ) {
    throw new RangeError('Topology atlas dimensions must match the maze graph.')
  }

  const leakedTexels = new Set<number>()
  const recordIfPainted = (x: number, y: number): void => {
    const texelIndex = y * atlas.width + x
    if (atlas.data[texelIndex * 4] > 0) leakedTexels.add(texelIndex)
  }

  for (let row = 0; row < graph.rows; row += 1) {
    const atlasBottom = (graph.rows - 1 - row) * pixelsPerCell
    for (let col = 0; col < graph.cols; col += 1) {
      const cellIndex = row * graph.cols + col
      const cell = graph.cells[cellIndex]
      const atlasLeft = col * pixelsPerCell

      if (col + 1 < graph.cols) {
        const rightCell = graph.cells[cellIndex + 1]
        if (
          (cell.active || rightCell.active) &&
          !isOpenInteriorPassage(graph, cellIndex, 'right')
        ) {
          const leftEdgeX = atlasLeft + pixelsPerCell - 1
          const rightEdgeX = leftEdgeX + 1
          for (let offset = 0; offset < pixelsPerCell; offset += 1) {
            const y = atlasBottom + offset
            recordIfPainted(leftEdgeX, y)
            recordIfPainted(rightEdgeX, y)
          }
        }
      }

      if (row + 1 < graph.rows) {
        const bottomCell = graph.cells[cellIndex + graph.cols]
        if (
          (cell.active || bottomCell.active) &&
          !isOpenInteriorPassage(graph, cellIndex, 'bottom')
        ) {
          const topCellEdgeY = atlasBottom
          const bottomCellEdgeY = topCellEdgeY - 1
          for (let offset = 0; offset < pixelsPerCell; offset += 1) {
            const x = atlasLeft + offset
            recordIfPainted(x, topCellEdgeY)
            recordIfPainted(x, bottomCellEdgeY)
          }
        }
      }
    }
  }

  return leakedTexels.size
}

const DEFAULT_PIXELS_PER_CELL = 12
const DEFAULT_MAX_TEXTURE_SIZE = 2_048
const DEFAULT_CHANNEL_INSET_RATIO = 0.16

const DIRECTION_DELTAS: Readonly<Record<WallDirection, readonly [number, number]>> = {
  top: [-1, 0],
  right: [0, 1],
  bottom: [1, 0],
  left: [0, -1],
}

const OPPOSITE_DIRECTION: Readonly<Record<WallDirection, WallDirection>> = {
  top: 'bottom',
  right: 'left',
  bottom: 'top',
  left: 'right',
}

function assertGraph(graph: MazeGraph): void {
  if (
    !Number.isInteger(graph.rows) ||
    !Number.isInteger(graph.cols) ||
    graph.rows < 1 ||
    graph.cols < 1 ||
    graph.cells.length !== graph.rows * graph.cols
  ) {
    throw new RangeError('Maze graph dimensions and cell storage must agree.')
  }
}

function resolvePixelsPerCell(
  graph: MazeGraph,
  requested: number,
  maximumTextureSize: number,
): number {
  if (!Number.isFinite(requested) || requested < 2) {
    throw new RangeError('pixelsPerCell must be at least 2.')
  }
  if (!Number.isFinite(maximumTextureSize) || maximumTextureSize < 2) {
    throw new RangeError('maxTextureSize must be at least 2.')
  }
  const fittingScale = Math.floor(
    Math.floor(maximumTextureSize) / Math.max(graph.rows, graph.cols),
  )
  if (fittingScale < 2) {
    throw new RangeError('maxTextureSize must fit at least two texels per cell.')
  }
  return Math.max(2, Math.min(Math.floor(requested), fittingScale))
}

function isOpenInteriorPassage(
  graph: MazeGraph,
  cellIndex: number,
  direction: WallDirection,
): boolean {
  const cell = graph.cells[cellIndex]
  if (!cell.active || cell.walls[direction]) return false
  const [rowDelta, colDelta] = DIRECTION_DELTAS[direction]
  const neighborRow = cell.row + rowDelta
  const neighborCol = cell.col + colDelta
  if (
    neighborRow < 0 ||
    neighborRow >= graph.rows ||
    neighborCol < 0 ||
    neighborCol >= graph.cols
  ) {
    return false
  }
  const neighbor = graph.cells[neighborRow * graph.cols + neighborCol]
  return neighbor?.active === true && !neighbor.walls[OPPOSITE_DIRECTION[direction]]
}

/** Builds the high-resolution topology mask once per maze topology. */
export function buildWaterTopologyAtlas(
  graph: MazeGraph,
  options: WaterTopologyAtlasOptions = {},
): WaterTopologyAtlas {
  assertGraph(graph)
  const pixelsPerCell = resolvePixelsPerCell(
    graph,
    options.pixelsPerCell ?? DEFAULT_PIXELS_PER_CELL,
    options.maxTextureSize ?? DEFAULT_MAX_TEXTURE_SIZE,
  )
  const insetRatio = options.channelInsetRatio ?? DEFAULT_CHANNEL_INSET_RATIO
  if (!Number.isFinite(insetRatio) || insetRatio < 0 || insetRatio >= 0.5) {
    throw new RangeError('channelInsetRatio must be in the range [0, 0.5).')
  }

  let activeCount = 0
  for (let index = 0; index < graph.cells.length; index += 1) {
    if (graph.cells[index].active) activeCount += 1
  }
  const activeCellIndices = options.nodeCellIndices
    ? new Int32Array(options.nodeCellIndices)
    : new Int32Array(activeCount)
  const cellToActiveIndex = new Int32Array(graph.cells.length)
  cellToActiveIndex.fill(-1)
  if (activeCellIndices.length !== activeCount) {
    throw new RangeError('nodeCellIndices must contain every active cell exactly once.')
  }
  if (!options.nodeCellIndices) {
    let activeIndex = 0
    for (let index = 0; index < graph.cells.length; index += 1) {
      if (!graph.cells[index].active) continue
      activeCellIndices[activeIndex++] = index
    }
  }
  for (let nodeIndex = 0; nodeIndex < activeCellIndices.length; nodeIndex += 1) {
    const cellIndex = activeCellIndices[nodeIndex]
    if (
      cellIndex < 0 ||
      cellIndex >= graph.cells.length ||
      !graph.cells[cellIndex].active ||
      cellToActiveIndex[cellIndex] >= 0
    ) {
      throw new RangeError('nodeCellIndices must contain every active cell exactly once.')
    }
    cellToActiveIndex[cellIndex] = nodeIndex
  }

  const width = graph.cols * pixelsPerCell
  const height = graph.rows * pixelsPerCell
  const data = new Uint8Array(width * height * 4)
  const texelToActiveIndex = new Int32Array(width * height)
  texelToActiveIndex.fill(-1)
  const inset = Math.min(
    Math.floor((pixelsPerCell - 1) / 2),
    Math.max(0, Math.round(pixelsPerCell * insetRatio)),
  )

  const paint = (
    ownerActiveIndex: number,
    cellIndex: number,
    startX: number,
    endX: number,
    startY: number,
    endY: number,
  ): void => {
    const source = cellIndex === options.sourceCellIndex ? 255 : 0
    const outlet = cellIndex === options.outletCellIndex ? 255 : 0
    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const texelIndex = y * width + x
        const offset = texelIndex * 4
        data[offset] = 255
        data[offset + 1] = Math.max(data[offset + 1], source)
        data[offset + 2] = Math.max(data[offset + 2], outlet)
        data[offset + 3] = 255
        if (texelToActiveIndex[texelIndex] < 0) {
          texelToActiveIndex[texelIndex] = ownerActiveIndex
        }
      }
    }
  }

  for (let nodeIndex = 0; nodeIndex < activeCellIndices.length; nodeIndex += 1) {
    const cellIndex = activeCellIndices[nodeIndex]
    const cell = graph.cells[cellIndex]
    const left = cell.col * pixelsPerCell
    const bottom = (graph.rows - 1 - cell.row) * pixelsPerCell
    const innerLeft = left + inset
    const innerRight = left + pixelsPerCell - 1 - inset
    const innerBottom = bottom + inset
    const innerTop = bottom + pixelsPerCell - 1 - inset

    paint(
      nodeIndex,
      cellIndex,
      innerLeft,
      innerRight,
      innerBottom,
      innerTop,
    )

    if (isOpenInteriorPassage(graph, cellIndex, 'left')) {
      paint(nodeIndex, cellIndex, left, innerLeft, innerBottom, innerTop)
    }
    if (isOpenInteriorPassage(graph, cellIndex, 'right')) {
      paint(
        nodeIndex,
        cellIndex,
        innerRight,
        left + pixelsPerCell - 1,
        innerBottom,
        innerTop,
      )
    }
    if (isOpenInteriorPassage(graph, cellIndex, 'bottom')) {
      paint(nodeIndex, cellIndex, innerLeft, innerRight, bottom, innerBottom)
    }
    if (isOpenInteriorPassage(graph, cellIndex, 'top')) {
      paint(
        nodeIndex,
        cellIndex,
        innerLeft,
        innerRight,
        innerTop,
        bottom + pixelsPerCell - 1,
      )
    }
  }

  return {
    width,
    height,
    pixelsPerCell,
    data,
    activeCellIndices,
    cellToActiveIndex,
    texelToActiveIndex,
  }
}
