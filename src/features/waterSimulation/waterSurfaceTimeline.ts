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
  /**
   * RGBA float atlas: arrival time, full time, retained water level, noise seed.
   */
  schedule: Float32Array
  /**
   * RGBA byte atlas: channel coverage, flow X, flow Y, noise seed.
   */
  field: Uint8Array
}

interface SurfacePoint {
  x: number
  y: number
}

interface SurfaceSample {
  arrivalMs: number
  fullMs: number
  retainedLevel: number
}

interface FlowVector {
  x: number
  y: number
}

const DEFAULT_PIXELS_PER_CELL = 12
const DEFAULT_MAX_TEXTURE_SIZE = 2_048
const MIN_PIXELS_PER_CELL = 2
const DISTANCE_EPSILON = 1e-6

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
  const largestAllowedScale = Math.floor(
    textureLimit / maximumGridDimension,
  )
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

function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function hashTexel(seed: number, x: number, y: number): number {
  let hash =
    seed ^
    Math.imul(x + 1, 0x9e3779b1) ^
    Math.imul(y + 1, 0x85ebca77)
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d)
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b)
  hash ^= hash >>> 16
  return hash >>> 0
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

function pointForCell(
  graph: MazeGraph,
  pixelsPerCell: number,
  row: number,
  col: number,
): SurfacePoint {
  const centerOffset = Math.floor(pixelsPerCell / 2)
  return {
    x: col * pixelsPerCell + centerOffset,
    y: (graph.rows - 1 - row) * pixelsPerCell + centerOffset,
  }
}

function asSurfaceSample(
  cell: WaterSimulationCell | undefined,
): SurfaceSample | null {
  if (
    !cell?.reachable ||
    cell.arrivalMs === null ||
    cell.fullMs === null ||
    !Number.isFinite(cell.arrivalMs) ||
    !Number.isFinite(cell.fullMs)
  ) {
    return null
  }
  return {
    arrivalMs: Math.max(0, cell.arrivalMs),
    fullMs: Math.max(cell.arrivalMs, cell.fullMs),
    retainedLevel: clamp(cell.retainedLevel, 0, 1),
  }
}

function flowForCell(
  cell: WaterSimulationCell,
  model: WaterSimulationModel,
): FlowVector {
  if (cell.incomingDirection) {
    return vectorForDirection(cell.incomingDirection)
  }
  if (cell.index === model.sourceIndex) {
    return { x: 0, y: -1 }
  }
  return { x: 0, y: 0 }
}

/**
 * Builds two shader-ready texture atlases from the graph water schedule.
 *
 * Texel row zero represents the graph's bottom edge, matching PlaneGeometry
 * UV coordinates without a renderer-side vertical flip.
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
  const closestDistance = new Float32Array(texelCount)
  closestDistance.fill(Number.POSITIVE_INFINITY)

  const graphSeed = hashString(
    `${graph.seed}\u0000${graph.rows}x${graph.cols}`,
  )
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const texelIndex = y * width + x
      const offset = texelIndex * 4
      const seed = hashTexel(graphSeed, x, y) / 0xffffffff
      schedule[offset + 3] = seed
      field[offset + 1] = encodeFlowComponent(0)
      field[offset + 2] = encodeFlowComponent(0)
      field[offset + 3] = Math.round(seed * 255)
    }
  }

  const scheduleByIndex = new Map<number, WaterSimulationCell>()
  for (const cell of model.cells) {
    scheduleByIndex.set(cell.index, cell)
  }

  const channelRadius = Math.max(0.5, pixelsPerCell * 0.24)
  let latestScheduledTime = Math.max(
    0,
    Number.isFinite(model.totalDurationMs) ? model.totalDurationMs : 0,
  )

  const paintCapsule = (
    from: SurfacePoint,
    to: SurfacePoint,
    fromSample: SurfaceSample,
    toSample: SurfaceSample,
    flow: FlowVector,
  ): void => {
    latestScheduledTime = Math.max(
      latestScheduledTime,
      fromSample.arrivalMs,
      fromSample.fullMs,
      toSample.arrivalMs,
      toSample.fullMs,
    )

    const deltaX = to.x - from.x
    const deltaY = to.y - from.y
    const lengthSquared = deltaX * deltaX + deltaY * deltaY
    const edge = channelRadius + 0.5
    const minimumX = Math.max(0, Math.floor(Math.min(from.x, to.x) - edge))
    const maximumX = Math.min(
      width - 1,
      Math.ceil(Math.max(from.x, to.x) + edge),
    )
    const minimumY = Math.max(0, Math.floor(Math.min(from.y, to.y) - edge))
    const maximumY = Math.min(
      height - 1,
      Math.ceil(Math.max(from.y, to.y) + edge),
    )
    const encodedFlowX = encodeFlowComponent(flow.x)
    const encodedFlowY = encodeFlowComponent(flow.y)

    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const projection =
          lengthSquared === 0
            ? 0
            : clamp(
              ((x - from.x) * deltaX + (y - from.y) * deltaY) /
                  lengthSquared,
              0,
              1,
            )
        const nearestX = from.x + deltaX * projection
        const nearestY = from.y + deltaY * projection
        const distance = Math.hypot(x - nearestX, y - nearestY)
        const coverage = clamp(edge - distance, 0, 1)
        if (coverage <= 0) continue

        const texelIndex = y * width + x
        const offset = texelIndex * 4
        const encodedCoverage = Math.round(coverage * 255)
        field[offset] = Math.max(field[offset], encodedCoverage)

        if (distance >= closestDistance[texelIndex] - DISTANCE_EPSILON) {
          continue
        }
        closestDistance[texelIndex] = distance
        schedule[offset] =
          fromSample.arrivalMs +
          (toSample.arrivalMs - fromSample.arrivalMs) * projection
        schedule[offset + 1] =
          fromSample.fullMs +
          (toSample.fullMs - fromSample.fullMs) * projection
        schedule[offset + 2] =
          fromSample.retainedLevel +
          (toSample.retainedLevel - fromSample.retainedLevel) * projection
        field[offset + 1] = encodedFlowX
        field[offset + 2] = encodedFlowY
      }
    }
  }

  for (const cell of graph.cells) {
    const cellSchedule = scheduleByIndex.get(cell.index)
    const cellSample = asSurfaceSample(cellSchedule)
    if (!cell.active || !cellSample) continue

    for (const { cell: neighbor } of getPassageNeighbors(graph, cell)) {
      if (neighbor.index <= cell.index) continue
      const neighborSchedule = scheduleByIndex.get(neighbor.index)
      const neighborSample = asSurfaceSample(neighborSchedule)
      if (!neighborSchedule || !neighborSample) continue

      const cellIsEarlier =
        cellSample.arrivalMs < neighborSample.arrivalMs ||
        (cellSample.arrivalMs === neighborSample.arrivalMs &&
          cell.index < neighbor.index)
      const earlyCell = cellIsEarlier ? cell : neighbor
      const lateCell = cellIsEarlier ? neighbor : cell
      const earlySample = cellIsEarlier ? cellSample : neighborSample
      const lateSample = cellIsEarlier ? neighborSample : cellSample
      const from = pointForCell(
        graph,
        pixelsPerCell,
        earlyCell.row,
        earlyCell.col,
      )
      const to = pointForCell(
        graph,
        pixelsPerCell,
        lateCell.row,
        lateCell.col,
      )
      const deltaX = to.x - from.x
      const deltaY = to.y - from.y
      const length = Math.hypot(deltaX, deltaY) || 1
      paintCapsule(from, to, earlySample, lateSample, {
        x: deltaX / length,
        y: deltaY / length,
      })
    }
  }

  const sourceSchedule = scheduleByIndex.get(model.sourceIndex)
  const sourceSample = asSurfaceSample(sourceSchedule)
  if (sourceSchedule && sourceSample) {
    const sourcePoint = pointForCell(
      graph,
      pixelsPerCell,
      sourceSchedule.position.row,
      sourceSchedule.position.col,
    )
    paintCapsule(
      { x: sourcePoint.x, y: height - 1 },
      sourcePoint,
      sourceSample,
      sourceSample,
      { x: 0, y: -1 },
    )
  }

  const exitSchedule = scheduleByIndex.get(model.exitIndex)
  const exitSample = asSurfaceSample(exitSchedule)
  if (exitSchedule && exitSample) {
    const exitPoint = pointForCell(
      graph,
      pixelsPerCell,
      exitSchedule.position.row,
      exitSchedule.position.col,
    )
    const downwardTravelMs = Number.isFinite(
      model.options.downwardTravelMs,
    )
      ? model.options.downwardTravelMs
      : 0
    const outletTravelMs = Math.max(0, downwardTravelMs) * 0.5
    const outletSample: SurfaceSample = {
      arrivalMs: exitSample.arrivalMs + outletTravelMs,
      fullMs: exitSample.fullMs + outletTravelMs,
      retainedLevel: exitSample.retainedLevel,
    }
    paintCapsule(
      exitPoint,
      { x: exitPoint.x, y: 0 },
      exitSample,
      outletSample,
      { x: 0, y: -1 },
    )
  }

  for (const cell of graph.cells) {
    const cellSchedule = scheduleByIndex.get(cell.index)
    const cellSample = asSurfaceSample(cellSchedule)
    if (!cell.active || !cellSchedule || !cellSample) continue
    const point = pointForCell(
      graph,
      pixelsPerCell,
      cell.row,
      cell.col,
    )
    paintCapsule(
      point,
      point,
      cellSample,
      cellSample,
      flowForCell(cellSchedule, model),
    )
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
