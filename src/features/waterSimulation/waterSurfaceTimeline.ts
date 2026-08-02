import {
  getPassageNeighbors,
  type MazeGraph,
  type WallDirection,
} from '../../core/maze'
import type {
  WaterSimulationCell,
  WaterSimulationModel,
} from './waterModel'

export interface WaterSurfaceTimelineOptions {
  pixelsPerCell?: number
  maxTextureSize?: number
}

export interface WaterSurfaceTimeline {
  width: number
  height: number
  pixelsPerCell: number
  maxTimeMs: number
  /** RGBA float atlas: arrival time, full time, retained visibility, validity. */
  schedule: Float32Array
  /** RGBA byte atlas: channel coverage, flow X, flow Y, peak intensity. */
  field: Uint8Array
}

interface SurfaceSample {
  arrivalMs: number
  fullMs: number
  peakLevel: number
  retainedLevel: number
}

interface FlowVector {
  x: number
  y: number
}

interface CellBounds {
  left: number
  right: number
  bottom: number
  top: number
  centerX: number
  centerY: number
  innerLeft: number
  innerRight: number
  innerBottom: number
  innerTop: number
  innerHeight: number
}

const DEFAULT_PIXELS_PER_CELL = 12
const DEFAULT_MAX_TEXTURE_SIZE = 2_048
const MIN_PIXELS_PER_CELL = 2
const LEVEL_EPSILON = 1e-6
// A physically correct six-percent film is less than one texel on the
// low-quality atlas and almost disappears against the pale maze floor. Keep
// the conserved level in the model, but exaggerate its rendered cross-section
// just enough for a person to follow the connected wet passage.
const MINIMUM_VISIBLE_FILM_LEVEL = 0.18

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`)
  }
}

function resolvePixelsPerCell(
  graph: MazeGraph,
  options: WaterSurfaceTimelineOptions,
): number {
  if (
    !Number.isInteger(graph.rows) ||
    !Number.isInteger(graph.cols) ||
    graph.rows < 1 ||
    graph.cols < 1
  ) {
    throw new RangeError('Maze dimensions must be positive integers.')
  }

  const requested = options.pixelsPerCell ?? DEFAULT_PIXELS_PER_CELL
  const maxTextureSize = options.maxTextureSize ?? DEFAULT_MAX_TEXTURE_SIZE
  assertPositiveFinite('pixelsPerCell', requested)
  assertPositiveFinite('maxTextureSize', maxTextureSize)

  const textureLimit = Math.floor(maxTextureSize)
  const maximumGridDimension = Math.max(graph.rows, graph.cols)
  const largestAllowedScale = Math.floor(textureLimit / maximumGridDimension)
  if (largestAllowedScale < MIN_PIXELS_PER_CELL) {
    throw new RangeError(
      `maxTextureSize must allow at least ${MIN_PIXELS_PER_CELL} pixels per maze cell.`,
    )
  }

  return Math.min(
    Math.max(MIN_PIXELS_PER_CELL, Math.floor(requested)),
    largestAllowedScale,
  )
}

function encodeFlowComponent(value: number): number {
  return Math.round((clamp(value, -1, 1) * 0.5 + 0.5) * 255)
}

function vectorForDirection(direction: WallDirection): FlowVector {
  if (direction === 'right') return { x: 1, y: 0 }
  if (direction === 'left') return { x: -1, y: 0 }
  // Texture Y grows upward, while graph rows grow downward.
  if (direction === 'bottom') return { x: 0, y: -1 }
  return { x: 0, y: 1 }
}

function asSurfaceSample(
  cell: WaterSimulationCell | undefined,
  steadyFlowLevel: number,
): SurfaceSample | null {
  if (
    !cell?.reachable ||
    cell.arrivalMs === null ||
    cell.fullMs === null ||
    !Number.isFinite(cell.arrivalMs) ||
    !Number.isFinite(cell.fullMs) ||
    cell.peakLevel <= 0
  ) {
    return null
  }
  const physicalPeakLevel = clamp(cell.peakLevel, 0, 1)
  const physicalRetainedLevel = clamp(cell.retainedLevel, 0, 1)
  const visualFloor =
    cell.drainage === 'drains' || cell.drainage === 'exit'
      ? Math.max(MINIMUM_VISIBLE_FILM_LEVEL, steadyFlowLevel)
      : MINIMUM_VISIBLE_FILM_LEVEL
  return {
    arrivalMs: Math.max(0, cell.arrivalMs),
    fullMs: Math.max(cell.arrivalMs + 1, cell.fullMs),
    peakLevel: clamp(Math.max(physicalPeakLevel, visualFloor), 0, 1),
    retainedLevel: clamp(
      Math.max(physicalRetainedLevel, visualFloor),
      0,
      1,
    ),
  }
}

function flowForCell(
  cell: WaterSimulationCell,
  model: WaterSimulationModel,
): FlowVector {
  if (cell.incomingDirection) return vectorForDirection(cell.incomingDirection)
  if (cell.index === model.sourceIndex) return { x: 0, y: -1 }
  return { x: 0, y: 0 }
}

function boundsForCell(
  graph: MazeGraph,
  pixelsPerCell: number,
  row: number,
  col: number,
): CellBounds {
  const left = col * pixelsPerCell
  const right = left + pixelsPerCell - 1
  const bottom = (graph.rows - 1 - row) * pixelsPerCell
  const top = bottom + pixelsPerCell - 1
  const inset = pixelsPerCell <= 3
    ? 0
    : Math.max(1, Math.round(pixelsPerCell * 0.13))
  const innerLeft = left + inset
  const innerRight = right - inset
  const innerBottom = bottom + inset
  const innerTop = top - inset
  return {
    left,
    right,
    bottom,
    top,
    centerX: left + Math.floor(pixelsPerCell / 2),
    centerY: bottom + Math.floor(pixelsPerCell / 2),
    innerLeft,
    innerRight,
    innerBottom,
    innerTop,
    innerHeight: Math.max(1, innerTop - innerBottom + 1),
  }
}

/**
 * Builds a shader timeline from hydraulic cell levels.
 *
 * Stored water is rasterized from each cell floor upward. Horizontal portals
 * join only the shared submerged height, while vertical passages use a narrow
 * gravity stream (or a full spill column when the lower cell supplied the
 * upper one). Closed walls never receive atlas coverage.
 */
export function buildWaterSurfaceTimeline(
  graph: MazeGraph,
  model: WaterSimulationModel,
  options: WaterSurfaceTimelineOptions = {},
): WaterSurfaceTimeline {
  const pixelsPerCell = resolvePixelsPerCell(graph, options)
  const width = graph.cols * pixelsPerCell
  const height = graph.rows * pixelsPerCell
  const texelCount = width * height
  const schedule = new Float32Array(texelCount * 4)
  const field = new Uint8Array(texelCount * 4)
  const winningCoverage = new Uint8Array(texelCount)
  const winningArrival = new Float64Array(texelCount)
  winningArrival.fill(Number.POSITIVE_INFINITY)

  for (let texelIndex = 0; texelIndex < texelCount; texelIndex += 1) {
    const offset = texelIndex * 4
    field[offset + 1] = encodeFlowComponent(0)
    field[offset + 2] = encodeFlowComponent(0)
  }

  const scheduleByIndex = new Map<number, WaterSimulationCell>()
  for (const cell of model.cells) scheduleByIndex.set(cell.index, cell)

  let latestScheduledTime = Math.max(
    0,
    Number.isFinite(model.totalDurationMs) ? model.totalDurationMs : 0,
  )

  const writeTexel = (
    x: number,
    y: number,
    arrivalMs: number,
    fullMs: number,
    retainedVisibility: number,
    peakIntensity: number,
    flow: FlowVector,
    coverage = 255,
  ): void => {
    if (x < 0 || x >= width || y < 0 || y >= height || coverage <= 0) return
    const texelIndex = y * width + x
    const offset = texelIndex * 4
    const encodedCoverage = Math.round(clamp(coverage, 0, 255))
    field[offset] = Math.max(field[offset], encodedCoverage)
    const shouldReplace =
      encodedCoverage > winningCoverage[texelIndex] ||
      (encodedCoverage === winningCoverage[texelIndex] &&
        arrivalMs < winningArrival[texelIndex] - LEVEL_EPSILON)
    if (!shouldReplace) return

    winningCoverage[texelIndex] = encodedCoverage
    winningArrival[texelIndex] = arrivalMs
    schedule[offset] = Math.max(0, arrivalMs)
    schedule[offset + 1] = Math.max(arrivalMs + 1, fullMs)
    schedule[offset + 2] = clamp(retainedVisibility, 0, 1)
    schedule[offset + 3] = 1
    field[offset + 1] = encodeFlowComponent(flow.x)
    field[offset + 2] = encodeFlowComponent(flow.y)
    field[offset + 3] = Math.round(clamp(peakIntensity, 0, 1) * 255)
    latestScheduledTime = Math.max(
      latestScheduledTime,
      arrivalMs,
      fullMs,
    )
  }

  const paintBasin = (
    bounds: CellBounds,
    sample: SurfaceSample,
    flow: FlowVector,
  ): void => {
    const peakPixels = Math.max(
      1,
      Math.ceil(bounds.innerHeight * sample.peakLevel),
    )
    const surfaceY = Math.min(
      bounds.innerTop,
      bounds.innerBottom + peakPixels - 1,
    )
    for (let y = bounds.innerBottom; y <= surfaceY; y += 1) {
      const localHeight = clamp(
        (y - bounds.innerBottom + 0.5) / bounds.innerHeight,
        0,
        1,
      )
      const fillProgress = clamp(
        localHeight / Math.max(sample.peakLevel, LEVEL_EPSILON),
        0,
        1,
      )
      const arrivalMs =
        sample.arrivalMs +
        (sample.fullMs - sample.arrivalMs) * fillProgress * 0.82
      const retainedVisibility =
        localHeight <= sample.retainedLevel + LEVEL_EPSILON
          ? sample.retainedLevel
          : 0
      for (let x = bounds.innerLeft; x <= bounds.innerRight; x += 1) {
        const edgeDistance = Math.min(
          x - bounds.innerLeft,
          bounds.innerRight - x,
        )
        const coverage = edgeDistance === 0 && pixelsPerCell >= 5 ? 220 : 255
        writeTexel(
          x,
          y,
          arrivalMs,
          sample.fullMs,
          retainedVisibility,
          sample.peakLevel,
          flow,
          coverage,
        )
      }
    }
  }

  const boundsByIndex = new Map<number, CellBounds>()
  for (const cell of graph.cells) {
    const cellSchedule = scheduleByIndex.get(cell.index)
    const sample = asSurfaceSample(
      cellSchedule,
      model.options.steadyFlowLevel,
    )
    if (!cell.active || !cellSchedule || !sample) continue
    const bounds = boundsForCell(
      graph,
      pixelsPerCell,
      cell.row,
      cell.col,
    )
    boundsByIndex.set(cell.index, bounds)
    paintBasin(bounds, sample, flowForCell(cellSchedule, model))
  }

  const paintHorizontalPortal = (
    leftBounds: CellBounds,
    rightBounds: CellBounds,
    leftSample: SurfaceSample,
    rightSample: SurfaceSample,
  ): void => {
    const submergedLevel = Math.min(
      leftSample.peakLevel,
      rightSample.peakLevel,
    )
    const peakPixels = Math.max(
      1,
      Math.ceil(leftBounds.innerHeight * submergedLevel),
    )
    const surfaceY = Math.min(
      leftBounds.innerTop,
      leftBounds.innerBottom + peakPixels - 1,
    )
    const leftIsEarlier =
      leftSample.arrivalMs <= rightSample.arrivalMs
    const flow = leftIsEarlier ? { x: 1, y: 0 } : { x: -1, y: 0 }
    const fromSample = leftIsEarlier ? leftSample : rightSample
    const toSample = leftIsEarlier ? rightSample : leftSample
    const startX = leftBounds.innerRight + 1
    const endX = rightBounds.innerLeft - 1
    const span = Math.max(1, endX - startX)
    for (let x = startX; x <= endX; x += 1) {
      const progress = clamp((x - startX) / span, 0, 1)
      const directedProgress = leftIsEarlier ? progress : 1 - progress
      const arrivalMs =
        fromSample.arrivalMs +
        (toSample.arrivalMs - fromSample.arrivalMs) * directedProgress
      const fullMs =
        fromSample.fullMs +
        (toSample.fullMs - fromSample.fullMs) * directedProgress
      for (let y = leftBounds.innerBottom; y <= surfaceY; y += 1) {
        const localHeight =
          (y - leftBounds.innerBottom + 0.5) / leftBounds.innerHeight
        const retainedVisibility =
          localHeight <=
          Math.min(leftSample.retainedLevel, rightSample.retainedLevel) +
            LEVEL_EPSILON
            ? Math.min(
                leftSample.retainedLevel,
                rightSample.retainedLevel,
              )
            : 0
        writeTexel(
          x,
          y,
          arrivalMs,
          fullMs,
          retainedVisibility,
          submergedLevel,
          flow,
        )
      }
    }
  }

  const paintVerticalPassage = (
    upperBounds: CellBounds,
    lowerBounds: CellBounds,
    upperCell: WaterSimulationCell,
    lowerCell: WaterSimulationCell,
    upperSample: SurfaceSample,
    lowerSample: SurfaceSample,
  ): void => {
    const lowerPeakPixels = Math.max(
      1,
      Math.ceil(lowerBounds.innerHeight * lowerSample.peakLevel),
    )
    const lowerSurfaceY = Math.min(
      lowerBounds.innerTop,
      lowerBounds.innerBottom + lowerPeakPixels - 1,
    )
    const climbedFromLower =
      upperCell.incomingIndex === lowerCell.index &&
      upperCell.incomingDirection === 'top'
    const halfWidth = Math.max(
      0,
      Math.round(pixelsPerCell * (climbedFromLower ? 0.22 : 0.11)),
    )
    const startY = Math.min(lowerSurfaceY, upperBounds.innerBottom)
    const endY = Math.max(lowerSurfaceY, upperBounds.innerBottom)
    const span = Math.max(1, endY - startY)
    const upperIsEarlier = upperSample.arrivalMs <= lowerSample.arrivalMs
    const flow = upperIsEarlier ? { x: 0, y: -1 } : { x: 0, y: 1 }
    const fromSample = upperIsEarlier ? upperSample : lowerSample
    const toSample = upperIsEarlier ? lowerSample : upperSample
    const retainedVisibility = Math.min(
      upperSample.retainedLevel,
      lowerSample.retainedLevel,
    )
    for (let y = startY; y <= endY; y += 1) {
      const bottomToTop = clamp((y - startY) / span, 0, 1)
      const directedProgress = upperIsEarlier ? 1 - bottomToTop : bottomToTop
      const arrivalMs =
        fromSample.arrivalMs +
        (toSample.arrivalMs - fromSample.arrivalMs) * directedProgress
      const fullMs =
        fromSample.fullMs +
        (toSample.fullMs - fromSample.fullMs) * directedProgress
      for (
        let x = upperBounds.centerX - halfWidth;
        x <= upperBounds.centerX + halfWidth;
        x += 1
      ) {
        writeTexel(
          x,
          y,
          arrivalMs,
          fullMs,
          retainedVisibility,
          Math.min(upperSample.peakLevel, lowerSample.peakLevel),
          flow,
        )
      }
    }
  }

  for (const cell of graph.cells) {
    const cellSchedule = scheduleByIndex.get(cell.index)
    const cellSample = asSurfaceSample(
      cellSchedule,
      model.options.steadyFlowLevel,
    )
    const cellBounds = boundsByIndex.get(cell.index)
    if (!cell.active || !cellSchedule || !cellSample || !cellBounds) continue

    for (const { cell: neighbor } of getPassageNeighbors(graph, cell)) {
      if (neighbor.index <= cell.index) continue
      const neighborSchedule = scheduleByIndex.get(neighbor.index)
      const neighborSample = asSurfaceSample(
        neighborSchedule,
        model.options.steadyFlowLevel,
      )
      const neighborBounds = boundsByIndex.get(neighbor.index)
      if (!neighborSchedule || !neighborSample || !neighborBounds) continue

      if (cell.row === neighbor.row) {
        if (cell.col < neighbor.col) {
          paintHorizontalPortal(
            cellBounds,
            neighborBounds,
            cellSample,
            neighborSample,
          )
        } else {
          paintHorizontalPortal(
            neighborBounds,
            cellBounds,
            neighborSample,
            cellSample,
          )
        }
      } else if (cell.row < neighbor.row) {
        paintVerticalPassage(
          cellBounds,
          neighborBounds,
          cellSchedule,
          neighborSchedule,
          cellSample,
          neighborSample,
        )
      } else {
        paintVerticalPassage(
          neighborBounds,
          cellBounds,
          neighborSchedule,
          cellSchedule,
          neighborSample,
          cellSample,
        )
      }
    }
  }

  const paintImpactDisk = (
    bounds: CellBounds,
    sample: SurfaceSample,
    radius: number,
  ): void => {
    const edge = radius + 0.5
    for (
      let y = Math.max(bounds.innerBottom, Math.floor(bounds.centerY - edge));
      y <= Math.min(bounds.innerTop, Math.ceil(bounds.centerY + edge));
      y += 1
    ) {
      for (
        let x = Math.max(bounds.innerLeft, Math.floor(bounds.centerX - edge));
        x <= Math.min(bounds.innerRight, Math.ceil(bounds.centerX + edge));
        x += 1
      ) {
        const distance = Math.hypot(x - bounds.centerX, y - bounds.centerY)
        const coverage = Math.round(clamp(edge - distance, 0, 1) * 255)
        writeTexel(
          x,
          y,
          sample.arrivalMs,
          sample.fullMs,
          sample.retainedLevel,
          Math.max(sample.peakLevel, 0.18),
          { x: 0, y: -1 },
          coverage,
        )
      }
    }
  }

  const sourceSchedule = scheduleByIndex.get(model.sourceIndex)
  const sourceSample = asSurfaceSample(
    sourceSchedule,
    model.options.steadyFlowLevel,
  )
  const sourceBounds = boundsByIndex.get(model.sourceIndex)
  if (sourceSchedule && sourceSample && sourceBounds) {
    paintImpactDisk(sourceBounds, sourceSample, pixelsPerCell * 0.18)
    const halfWidth = Math.max(0, Math.round(pixelsPerCell * 0.1))
    for (
      let y = sourceBounds.innerBottom;
      y <= Math.min(height - 1, sourceBounds.top + 1);
      y += 1
    ) {
      for (
        let x = sourceBounds.centerX - halfWidth;
        x <= sourceBounds.centerX + halfWidth;
        x += 1
      ) {
        writeTexel(
          x,
          y,
          sourceSample.arrivalMs,
          sourceSample.fullMs,
          sourceSample.retainedLevel,
          Math.max(sourceSample.peakLevel, 0.18),
          { x: 0, y: -1 },
        )
      }
    }
  }

  const exitSchedule = scheduleByIndex.get(model.exitIndex)
  const exitSample = asSurfaceSample(
    exitSchedule,
    model.options.steadyFlowLevel,
  )
  const exitBounds = boundsByIndex.get(model.exitIndex)
  if (exitSchedule && exitSample && exitBounds) {
    const halfWidth = Math.max(0, Math.round(pixelsPerCell * 0.11))
    const outletTravelMs = Math.max(0, model.options.downwardTravelMs) * 0.5
    for (
      let y = Math.max(0, exitBounds.bottom - 1);
      y <= exitBounds.innerBottom;
      y += 1
    ) {
      const progress =
        (exitBounds.innerBottom - y) /
        Math.max(1, exitBounds.innerBottom - exitBounds.bottom)
      for (
        let x = exitBounds.centerX - halfWidth;
        x <= exitBounds.centerX + halfWidth;
        x += 1
      ) {
        writeTexel(
          x,
          y,
          exitSample.arrivalMs + outletTravelMs * progress,
          exitSample.fullMs + outletTravelMs * progress,
          exitSample.retainedLevel,
          exitSample.peakLevel,
          { x: 0, y: -1 },
        )
      }
    }
  }

  return {
    width,
    height,
    pixelsPerCell,
    maxTimeMs: latestScheduledTime,
    schedule,
    field,
  }
}
