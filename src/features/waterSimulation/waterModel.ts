import {
  getActiveCell,
  getCellIndex,
  getPassageNeighbors,
  type CellPosition,
  type MazeGraph,
  type WallDirection,
} from '../../core/maze'

export interface WaterSimulationOptions {
  /** Milliseconds needed to cross one open passage while moving down. */
  downwardTravelMs?: number
  /** Milliseconds needed to cross one open horizontal passage. */
  horizontalTravelMs?: number
  /** Milliseconds needed to cross one open passage against gravity. */
  upwardTravelMs?: number
  /** Milliseconds spent filling a cell before water can leave it. */
  cellFillMs?: number
  /**
   * Additional traversal time per extra outgoing branch. A value of 0.4
   * makes a two-way split 40% slower than an unsplit flow.
   */
  branchSlowdown?: number
  /** Pause after the exit is reached before drain-down begins. */
  drainDelayMs?: number
  /** Time for drainable cells to settle to their retained level. */
  drainDurationMs?: number
  /** Thin film left in corridors that can drain to the exit. */
  residualFilmLevel?: number
  /** Stable depth maintained on the source-to-outlet route by continuous feed. */
  steadyFlowLevel?: number
  /** Water retained in a basin that would need to climb to escape. */
  pooledLevel?: number
  /**
   * Fraction of the through-flow volume that may be stored temporarily in
   * blind side branches before the outlet takes over the supplied flow.
   */
  sidePoolVolumeRatio?: number
  /** Peak visual depth of water that is actively carrying source-to-outlet flow. */
  flowPeakLevel?: number
  /** Smallest physically meaningful stored depth rendered as wet. */
  minimumWetLevel?: number
  /**
   * Require the source and exit to occupy the topmost and bottommost active
   * rows. This defaults to true because the visual simulation pours vertically.
   */
  enforceVerticalEndpoints?: boolean
}

export interface ResolvedWaterSimulationOptions {
  downwardTravelMs: number
  horizontalTravelMs: number
  upwardTravelMs: number
  cellFillMs: number
  branchSlowdown: number
  drainDelayMs: number
  drainDurationMs: number
  residualFilmLevel: number
  steadyFlowLevel: number
  pooledLevel: number
  sidePoolVolumeRatio: number
  flowPeakLevel: number
  minimumWetLevel: number
  enforceVerticalEndpoints: boolean
}

export type WaterDrainage =
  | 'unreachable'
  | 'drains'
  | 'pools'
  | 'exit'

export interface WaterCellSchedule {
  index: number
  position: CellPosition
  active: boolean
  /** True only when the finite hydraulic supply actually wets this cell. */
  reachable: boolean
  /** First contact with the water front. Null for unreachable cells. */
  arrivalMs: number | null
  /** Time at which the cell has reached its full animation level. */
  fullMs: number | null
  /** Edge depth in the deterministic earliest-arrival propagation tree. */
  depth: number | null
  /**
   * Stable branch identifier. Branch 0 follows the exit route; later IDs are
   * assigned at forks in arrival order. Null means the cell is unreachable.
   */
  branch: number | null
  /** Stable total ordering for equal-time rendering and particle emission. */
  order: number | null
  incomingIndex: number | null
  incomingDirection: WallDirection | null
  isDeadEnd: boolean
  drainage: WaterDrainage
  /** Greatest local fluid depth reached while the source is feeding. */
  peakLevel: number
  retainedLevel: number
}

/** Stable public name used by renderers and playback controllers. */
export type WaterSimulationCell = WaterCellSchedule

export interface WaterFlowSegment {
  fromIndex: number
  toIndex: number
  from: CellPosition
  to: CellPosition
  direction: WallDirection
  departureMs: number
  arrivalMs: number
  depth: number
  branch: number
}

export interface WaterSimulationModel {
  sourceIndex: number
  exitIndex: number
  source: CellPosition
  exit: CellPosition
  cells: WaterCellSchedule[]
  segments: WaterFlowSegment[]
  totalDurationMs: number
  exitArrivalMs: number | null
  reachedExit: boolean
  options: ResolvedWaterSimulationOptions
}

export type WaterCellState =
  | 'dry'
  | 'filling'
  | 'flowing'
  | 'draining'
  | 'pooled'
  | 'wet'
  | 'outlet'

export interface WaterCellFrame {
  index: number
  position: CellPosition
  level: number
  state: WaterCellState
}

export interface WaterSimulationFrame {
  elapsedMs: number
  progress: number
  reachedExit: boolean
  cells: WaterCellFrame[]
}

interface QueueEntry {
  index: number
  arrivalMs: number
}

const DEFAULT_OPTIONS: ResolvedWaterSimulationOptions = {
  downwardTravelMs: 90,
  horizontalTravelMs: 190,
  upwardTravelMs: 540,
  cellFillMs: 120,
  branchSlowdown: 0.4,
  drainDelayMs: 320,
  drainDurationMs: 900,
  residualFilmLevel: 0.06,
  steadyFlowLevel: 0.34,
  pooledLevel: 0.92,
  sidePoolVolumeRatio: 0.18,
  flowPeakLevel: 0.78,
  minimumWetLevel: 0.06,
  enforceVerticalEndpoints: true,
}

const DIRECTION_PRIORITY: Readonly<Record<WallDirection, number>> = {
  bottom: 0,
  right: 1,
  left: 2,
  top: 3,
}

const EPSILON = 1e-7

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const roundTime = (value: number): number =>
  Math.round((value + Number.EPSILON) * 1_000) / 1_000

function assertFiniteInRange(
  name: string,
  value: number,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`)
  }
}

function resolveOptions(
  input: WaterSimulationOptions = {},
): ResolvedWaterSimulationOptions {
  const options: ResolvedWaterSimulationOptions = {
    ...DEFAULT_OPTIONS,
    ...input,
  }
  assertFiniteInRange('downwardTravelMs', options.downwardTravelMs, 1)
  assertFiniteInRange('horizontalTravelMs', options.horizontalTravelMs, 1)
  assertFiniteInRange('upwardTravelMs', options.upwardTravelMs, 1)
  assertFiniteInRange('cellFillMs', options.cellFillMs, 1)
  assertFiniteInRange('branchSlowdown', options.branchSlowdown, 0, 4)
  assertFiniteInRange('drainDelayMs', options.drainDelayMs, 0)
  assertFiniteInRange('drainDurationMs', options.drainDurationMs, 1)
  assertFiniteInRange('residualFilmLevel', options.residualFilmLevel, 0, 1)
  assertFiniteInRange('steadyFlowLevel', options.steadyFlowLevel, 0, 1)
  assertFiniteInRange('pooledLevel', options.pooledLevel, 0, 1)
  assertFiniteInRange(
    'sidePoolVolumeRatio',
    options.sidePoolVolumeRatio,
    0,
    1,
  )
  assertFiniteInRange('flowPeakLevel', options.flowPeakLevel, 0.05, 1)
  assertFiniteInRange('minimumWetLevel', options.minimumWetLevel, 0.001, 0.5)
  if (options.pooledLevel < options.residualFilmLevel) {
    throw new RangeError(
      'pooledLevel must be greater than or equal to residualFilmLevel.',
    )
  }
  if (
    options.steadyFlowLevel < options.residualFilmLevel ||
    options.steadyFlowLevel > options.flowPeakLevel
  ) {
    throw new RangeError(
      'steadyFlowLevel must be between residualFilmLevel and flowPeakLevel.',
    )
  }
  if (options.minimumWetLevel > options.flowPeakLevel) {
    throw new RangeError(
      'minimumWetLevel must be less than or equal to flowPeakLevel.',
    )
  }
  return options
}

class MinArrivalQueue {
  private readonly heap: QueueEntry[] = []

  get size(): number {
    return this.heap.length
  }

  push(entry: QueueEntry): void {
    this.heap.push(entry)
    this.bubbleUp(this.heap.length - 1)
  }

  pop(): QueueEntry | undefined {
    const first = this.heap[0]
    const last = this.heap.pop()
    if (!first || !last) return first
    if (this.heap.length > 0) {
      this.heap[0] = last
      this.bubbleDown(0)
    }
    return first
  }

  private compare(left: QueueEntry, right: QueueEntry): number {
    if (Math.abs(left.arrivalMs - right.arrivalMs) > EPSILON) {
      return left.arrivalMs - right.arrivalMs
    }
    return left.index - right.index
  }

  private bubbleUp(startIndex: number): void {
    let index = startIndex
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.compare(this.heap[parent], this.heap[index]) <= 0) return
      ;[this.heap[parent], this.heap[index]] = [
        this.heap[index],
        this.heap[parent],
      ]
      index = parent
    }
  }

  private bubbleDown(startIndex: number): void {
    let index = startIndex
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if (
        left < this.heap.length &&
        this.compare(this.heap[left], this.heap[smallest]) < 0
      ) {
        smallest = left
      }
      if (
        right < this.heap.length &&
        this.compare(this.heap[right], this.heap[smallest]) < 0
      ) {
        smallest = right
      }
      if (smallest === index) return
      ;[this.heap[index], this.heap[smallest]] = [
        this.heap[smallest],
        this.heap[index],
      ]
      index = smallest
    }
  }
}

function assertSimulationEndpoints(
  graph: MazeGraph,
  start: CellPosition,
  end: CellPosition,
  enforceVerticalEndpoints: boolean,
): void {
  const sourceCell = getActiveCell(graph, start)
  const exitCell = getActiveCell(graph, end)
  if (!sourceCell) {
    throw new RangeError('Water source must be an active maze cell.')
  }
  if (!exitCell) {
    throw new RangeError('Water exit must be an active maze cell.')
  }
  if (!enforceVerticalEndpoints) return

  let topmostRow = Number.POSITIVE_INFINITY
  let bottommostRow = Number.NEGATIVE_INFINITY
  for (const cell of graph.cells) {
    if (!cell.active) continue
    topmostRow = Math.min(topmostRow, cell.row)
    bottommostRow = Math.max(bottommostRow, cell.row)
  }
  if (start.row !== topmostRow) {
    throw new RangeError('Water source must be on the topmost active maze row.')
  }
  if (end.row !== bottommostRow) {
    throw new RangeError('Water exit must be on the bottommost active maze row.')
  }
}

function travelTimeForDirection(
  direction: WallDirection,
  options: ResolvedWaterSimulationOptions,
): number {
  if (direction === 'bottom') return options.downwardTravelMs
  if (direction === 'top') return options.upwardTravelMs
  return options.horizontalTravelMs
}

function preferIncomingParent(
  candidateParent: number,
  currentParent: number,
  direction: WallDirection,
  currentDirection: WallDirection | null,
): boolean {
  if (currentParent < 0 || !currentDirection) return true
  const priorityDifference =
    DIRECTION_PRIORITY[direction] - DIRECTION_PRIORITY[currentDirection]
  return priorityDifference < 0 ||
    (priorityDifference === 0 && candidateParent < currentParent)
}

function calculateArrivalTree(
  graph: MazeGraph,
  sourceIndex: number,
  options: ResolvedWaterSimulationOptions,
  allowedIndices?: ReadonlySet<number>,
): {
  arrivals: number[]
  depths: number[]
  parents: number[]
  incomingDirections: Array<WallDirection | null>
} {
  const arrivals = new Array<number>(graph.cells.length).fill(
    Number.POSITIVE_INFINITY,
  )
  const depths = new Array<number>(graph.cells.length).fill(-1)
  const parents = new Array<number>(graph.cells.length).fill(-1)
  const incomingDirections = new Array<WallDirection | null>(
    graph.cells.length,
  ).fill(null)
  const queue = new MinArrivalQueue()

  arrivals[sourceIndex] = 0
  depths[sourceIndex] = 0
  queue.push({ index: sourceIndex, arrivalMs: 0 })

  while (queue.size > 0) {
    const currentEntry = queue.pop()
    if (!currentEntry) break
    if (currentEntry.arrivalMs > arrivals[currentEntry.index] + EPSILON) {
      continue
    }

    const currentCell = graph.cells[currentEntry.index]
    if (!currentCell?.active) continue
    const passageNeighbors = getPassageNeighbors(graph, currentCell).filter(
      ({ cell }) => !allowedIndices || allowedIndices.has(cell.index),
    )
    const parentIndex = parents[currentEntry.index]
    const outgoingCount = passageNeighbors.reduce(
      (count, neighbor) => count + (neighbor.cell.index === parentIndex ? 0 : 1),
      0,
    )
    const splitFactor =
      1 + Math.max(0, outgoingCount - 1) * options.branchSlowdown
    const departureMs = arrivals[currentEntry.index] + options.cellFillMs

    for (const { direction, cell: neighbor } of passageNeighbors) {
      const candidateArrival =
        departureMs +
        travelTimeForDirection(direction, options) * splitFactor
      const previousArrival = arrivals[neighbor.index]
      const isEarlier = candidateArrival < previousArrival - EPSILON
      const isPreferredTie =
        Math.abs(candidateArrival - previousArrival) <= EPSILON &&
        preferIncomingParent(
          currentEntry.index,
          parents[neighbor.index],
          direction,
          incomingDirections[neighbor.index],
        )
      if (!isEarlier && !isPreferredTie) continue

      arrivals[neighbor.index] = candidateArrival
      parents[neighbor.index] = currentEntry.index
      incomingDirections[neighbor.index] = direction
      depths[neighbor.index] = depths[currentEntry.index] + 1
      queue.push({ index: neighbor.index, arrivalMs: candidateArrival })
    }
  }

  return { arrivals, depths, parents, incomingDirections }
}

/**
 * Removes hydraulically dangling topology while preserving the source and
 * outlet. In a perfect maze the remaining cells are exactly the unique
 * source-to-outlet route. Braided loops remain because they can carry part of
 * the through-flow; blind trees are handled separately as finite storage.
 */
function calculateHydraulicBackbone(
  graph: MazeGraph,
  sourceIndex: number,
  exitIndex: number,
): Set<number> {
  const retained = new Uint8Array(graph.cells.length)
  const degrees = new Int32Array(graph.cells.length)
  const queue = new Int32Array(graph.cells.length)
  let queueStart = 0
  let queueEnd = 0

  for (const cell of graph.cells) {
    if (!cell.active) continue
    retained[cell.index] = 1
    degrees[cell.index] = getPassageNeighbors(graph, cell).length
  }
  for (const cell of graph.cells) {
    if (
      retained[cell.index] &&
      cell.index !== sourceIndex &&
      cell.index !== exitIndex &&
      degrees[cell.index] <= 1
    ) {
      queue[queueEnd++] = cell.index
    }
  }

  while (queueStart < queueEnd) {
    const index = queue[queueStart++]
    if (!retained[index] || index === sourceIndex || index === exitIndex) {
      continue
    }
    retained[index] = 0
    const cell = graph.cells[index]
    for (const { cell: neighbor } of getPassageNeighbors(graph, cell)) {
      if (!retained[neighbor.index]) continue
      degrees[neighbor.index] -= 1
      if (
        neighbor.index !== sourceIndex &&
        neighbor.index !== exitIndex &&
        degrees[neighbor.index] === 1
      ) {
        queue[queueEnd++] = neighbor.index
      }
    }
  }

  const result = new Set<number>()
  for (const cell of graph.cells) {
    if (retained[cell.index]) result.add(cell.index)
  }
  result.add(sourceIndex)
  result.add(exitIndex)
  return result
}

interface SideStorageCandidate {
  index: number
  parentIndex: number
  incomingDirection: WallDirection
  arrivalMs: number
  depth: number
  attachmentRow: number
  targetLevel: number
}

interface AllocatedSideStorage extends SideStorageCandidate {
  peakLevel: number
}

function compareHydraulicStoragePriority(
  graph: MazeGraph,
  left: SideStorageCandidate,
  right: SideStorageCandidate,
): number {
  const leftDrop = graph.cells[left.index].row - left.attachmentRow
  const rightDrop = graph.cells[right.index].row - right.attachmentRow
  if (leftDrop !== rightDrop) return rightDrop - leftDrop

  const directionDifference =
    DIRECTION_PRIORITY[left.incomingDirection] -
    DIRECTION_PRIORITY[right.incomingDirection]
  if (directionDifference !== 0) return directionDifference
  if (Math.abs(left.arrivalMs - right.arrivalMs) > EPSILON) {
    return left.arrivalMs - right.arrivalMs
  }
  return left.index - right.index
}

/**
 * Calculates transient water stored in blind branches. The allocation is
 * deliberately finite: once the outlet establishes through-flow, only the
 * supplied side-volume can remain in cul-de-sacs. Cells above the attachment
 * head are never flooded merely because they are graph-connected.
 */
function calculateSideStorage(
  graph: MazeGraph,
  backbone: ReadonlySet<number>,
  arrivals: readonly number[],
  depths: readonly number[],
  exitArrivalMs: number | null,
  options: ResolvedWaterSimulationOptions,
): Map<number, AllocatedSideStorage> {
  const candidateArrivals = new Array<number>(graph.cells.length).fill(
    Number.POSITIVE_INFINITY,
  )
  const candidateParents = new Int32Array(graph.cells.length)
  candidateParents.fill(-1)
  const candidateDirections = new Array<WallDirection | null>(
    graph.cells.length,
  ).fill(null)
  const candidateDepths = new Int32Array(graph.cells.length)
  candidateDepths.fill(-1)
  const attachmentRows = new Int32Array(graph.cells.length)
  attachmentRows.fill(-1)
  const queue = new MinArrivalQueue()

  const tryCandidate = (
    index: number,
    parentIndex: number,
    direction: WallDirection,
    arrivalMs: number,
    depth: number,
    attachmentRow: number,
  ) => {
    const previous = candidateArrivals[index]
    const preferred =
      arrivalMs < previous - EPSILON ||
      (Math.abs(arrivalMs - previous) <= EPSILON &&
        parentIndex < candidateParents[index])
    if (!preferred) return
    candidateArrivals[index] = arrivalMs
    candidateParents[index] = parentIndex
    candidateDirections[index] = direction
    candidateDepths[index] = depth
    attachmentRows[index] = attachmentRow
    queue.push({ index, arrivalMs })
  }

  for (const backboneIndex of backbone) {
    if (!Number.isFinite(arrivals[backboneIndex])) continue
    const cell = graph.cells[backboneIndex]
    const departureMs = arrivals[backboneIndex] + options.cellFillMs
    for (const { direction, cell: neighbor } of getPassageNeighbors(
      graph,
      cell,
    )) {
      if (backbone.has(neighbor.index) || neighbor.row < cell.row) continue
      tryCandidate(
        neighbor.index,
        backboneIndex,
        direction,
        departureMs + travelTimeForDirection(direction, options) * 1.5,
        Math.max(0, depths[backboneIndex]) + 1,
        cell.row,
      )
    }
  }

  while (queue.size > 0) {
    const entry = queue.pop()
    if (!entry) break
    if (entry.arrivalMs > candidateArrivals[entry.index] + EPSILON) continue
    const current = graph.cells[entry.index]
    const attachmentRow = attachmentRows[entry.index]
    const departureMs = entry.arrivalMs + options.cellFillMs * 1.35
    for (const { direction, cell: neighbor } of getPassageNeighbors(
      graph,
      current,
    )) {
      if (
        backbone.has(neighbor.index) ||
        neighbor.index === candidateParents[entry.index] ||
        neighbor.row < attachmentRow
      ) {
        continue
      }
      tryCandidate(
        neighbor.index,
        entry.index,
        direction,
        departureMs + travelTimeForDirection(direction, options) * 1.8,
        candidateDepths[entry.index] + 1,
        attachmentRow,
      )
    }
  }

  const latestBackboneArrival = arrivals.reduce(
    (latest, value) => Number.isFinite(value) ? Math.max(latest, value) : latest,
    0,
  )
  const feedCutoffMs =
    (exitArrivalMs ?? latestBackboneArrival) + options.drainDelayMs
  const candidates: SideStorageCandidate[] = graph.cells
    .filter(
      (cell) =>
        !backbone.has(cell.index) &&
        Number.isFinite(candidateArrivals[cell.index]) &&
        candidateArrivals[cell.index] <= feedCutoffMs + EPSILON &&
        candidateParents[cell.index] >= 0 &&
        candidateDirections[cell.index] !== null,
    )
    .map((cell) => {
      const attachmentRow = attachmentRows[cell.index]
      const verticalDrop = Math.max(0, cell.row - attachmentRow)
      const deadEnd = getPassageNeighbors(graph, cell).length <= 1
      const gravityStorage = verticalDrop > 0
        ? options.pooledLevel
        : Math.max(options.minimumWetLevel, options.flowPeakLevel * 0.42)
      return {
        index: cell.index,
        parentIndex: candidateParents[cell.index],
        incomingDirection: candidateDirections[cell.index] as WallDirection,
        arrivalMs: roundTime(candidateArrivals[cell.index]),
        depth: candidateDepths[cell.index],
        attachmentRow,
        targetLevel: clamp(
          gravityStorage + (deadEnd && verticalDrop > 0 ? 0.04 : 0),
          options.minimumWetLevel,
          1,
        ),
      }
    })
    .sort((left, right) =>
      left.arrivalMs - right.arrivalMs || left.index - right.index,
    )

  const flowingCellCount = arrivals.reduce(
    (count, value) => count + Number(Number.isFinite(value)),
    0,
  )
  const rootCandidateCount = candidates.reduce(
    (count, candidate) =>
      count + Number(backbone.has(candidate.parentIndex)),
    0,
  )
  let availableVolume = options.sidePoolVolumeRatio === 0
    ? 0
    : Math.max(
      options.minimumWetLevel * 2,
      options.minimumWetLevel * rootCandidateCount,
      flowingCellCount * options.sidePoolVolumeRatio,
    )
  const allocated = new Map<number, AllocatedSideStorage>()

  const childrenByParent = new Map<number, SideStorageCandidate[]>()
  for (const candidate of candidates) {
    const children = childrenByParent.get(candidate.parentIndex)
    if (children) children.push(candidate)
    else childrenByParent.set(candidate.parentIndex, [candidate])
  }

  // Treat every passage directly open from the hydraulic backbone as one
  // advancing water front. Giving each front its shallow wetting film before
  // deepening any one branch prevents an early cul-de-sac from consuming the
  // entire finite side volume while a later, visibly open side stays dry.
  let frontier = Array.from(backbone).flatMap(
    (index) => childrenByParent.get(index) ?? [],
  )
  while (
    frontier.length > 0 &&
    availableVolume + EPSILON >= options.minimumWetLevel
  ) {
    frontier.sort((left, right) =>
      compareHydraulicStoragePriority(graph, left, right),
    )
    const wettableCount = Math.min(
      frontier.length,
      Math.floor((availableVolume + EPSILON) / options.minimumWetLevel),
    )
    if (wettableCount === 0) break

    const selected = frontier.slice(0, wettableCount)
    const minimumAllocation =
      selected.length * options.minimumWetLevel
    const extraDemand = selected.reduce(
      (total, candidate) =>
        total + Math.max(0, candidate.targetLevel - options.minimumWetLevel),
      0,
    )
    const extraAllocation = Math.min(
      Math.max(0, availableVolume - minimumAllocation),
      extraDemand,
    )

    let groupAllocation = 0
    for (const candidate of selected) {
      const candidateExtra = extraDemand <= EPSILON
        ? 0
        : extraAllocation *
          Math.max(0, candidate.targetLevel - options.minimumWetLevel) /
          extraDemand
      const peakLevel = Math.min(
        candidate.targetLevel,
        options.minimumWetLevel + candidateExtra,
      )
      allocated.set(candidate.index, { ...candidate, peakLevel })
      groupAllocation += peakLevel
    }
    availableVolume = Math.max(0, availableVolume - groupAllocation)

    const filledWholeFront =
      wettableCount === frontier.length &&
      extraAllocation + EPSILON >= extraDemand
    if (!filledWholeFront) break
    frontier = selected.flatMap(
      (candidate) => childrenByParent.get(candidate.index) ?? [],
    )
  }

  return allocated
}

function collectExitRoute(parents: readonly number[], exitIndex: number): Set<number> {
  const route = new Set<number>()
  let index = exitIndex
  while (index >= 0 && !route.has(index)) {
    route.add(index)
    index = parents[index]
  }
  return route
}

function assignBranches(
  graph: MazeGraph,
  sourceIndex: number,
  arrivals: readonly number[],
  parents: readonly number[],
  incomingDirections: ReadonlyArray<WallDirection | null>,
  exitRoute: ReadonlySet<number>,
): number[] {
  const branches = new Array<number>(graph.cells.length).fill(-1)
  const children = Array.from(
    { length: graph.cells.length },
    () => [] as number[],
  )
  for (let index = 0; index < parents.length; index += 1) {
    const parent = parents[index]
    if (parent >= 0) children[parent].push(index)
  }

  branches[sourceIndex] = 0
  let nextBranch = 1
  const queue = [sourceIndex]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const parent = queue[cursor]
    children[parent].sort((left, right) => {
      const routeDifference =
        Number(exitRoute.has(right)) - Number(exitRoute.has(left))
      if (routeDifference !== 0) return routeDifference
      const arrivalDifference = arrivals[left] - arrivals[right]
      if (Math.abs(arrivalDifference) > EPSILON) return arrivalDifference
      const leftDirection = incomingDirections[left]
      const rightDirection = incomingDirections[right]
      if (leftDirection && rightDirection) {
        const directionDifference =
          DIRECTION_PRIORITY[leftDirection] - DIRECTION_PRIORITY[rightDirection]
        if (directionDifference !== 0) return directionDifference
      }
      return left - right
    })

    children[parent].forEach((child, childOrder) => {
      branches[child] =
        childOrder === 0 ? branches[parent] : nextBranch++
      queue.push(child)
    })
  }
  return branches
}

/**
 * Marks cells that can reach the bottom exit without ever moving upward.
 * Reachable cells outside this set form gravity basins and retain pooled water.
 */
function calculateGravityDrainage(
  graph: MazeGraph,
  exitIndex: number,
): Set<number> {
  const canDrain = new Set<number>([exitIndex])
  const queue = [exitIndex]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentIndex = queue[cursor]
    const current = graph.cells[currentIndex]
    for (const { cell: neighbor } of getPassageNeighbors(graph, current)) {
      if (canDrain.has(neighbor.index)) continue
      // Forward flow from neighbor to current is horizontal or downward.
      if (neighbor.row > current.row) continue
      canDrain.add(neighbor.index)
      queue.push(neighbor.index)
    }
  }
  return canDrain
}

/**
 * Builds a deterministic source-to-outlet hydraulic model without consulting
 * the maze solution. Steady through-flow is found by pruning zero-discharge
 * blind topology; gravity-favourable cul-de-sacs then receive only a finite
 * share of the supplied volume. Graph connectivity alone never makes a dry
 * corridor appear full.
 */
export function buildWaterSimulation(
  graph: MazeGraph,
  start: CellPosition,
  end: CellPosition,
  inputOptions: WaterSimulationOptions = {},
): WaterSimulationModel {
  const options = resolveOptions(inputOptions)
  assertSimulationEndpoints(
    graph,
    start,
    end,
    options.enforceVerticalEndpoints,
  )
  const sourceIndex = getCellIndex(graph.cols, start)
  const exitIndex = getCellIndex(graph.cols, end)
  const backbone = calculateHydraulicBackbone(
    graph,
    sourceIndex,
    exitIndex,
  )
  const { arrivals, depths, parents, incomingDirections } =
    calculateArrivalTree(graph, sourceIndex, options, backbone)
  const reachedExit = Number.isFinite(arrivals[exitIndex])
  const exitArrivalMs = reachedExit ? roundTime(arrivals[exitIndex]) : null
  const sideStorage = calculateSideStorage(
    graph,
    backbone,
    arrivals,
    depths,
    exitArrivalMs,
    options,
  )
  for (const side of sideStorage.values()) {
    arrivals[side.index] = side.arrivalMs
    parents[side.index] = side.parentIndex
    incomingDirections[side.index] = side.incomingDirection
    depths[side.index] = side.depth
  }
  const exitRoute = reachedExit
    ? collectExitRoute(parents, exitIndex)
    : new Set<number>([sourceIndex])
  const branches = assignBranches(
    graph,
    sourceIndex,
    arrivals,
    parents,
    incomingDirections,
    exitRoute,
  )
  const canDrain = reachedExit
    ? calculateGravityDrainage(graph, exitIndex)
    : new Set<number>()

  const reachableIndices = graph.cells
    .filter((cell) => cell.active && Number.isFinite(arrivals[cell.index]))
    .map((cell) => cell.index)
    .sort((left, right) => {
      const arrivalDifference = arrivals[left] - arrivals[right]
      if (Math.abs(arrivalDifference) > EPSILON) return arrivalDifference
      return left - right
    })
  const orderByIndex = new Array<number>(graph.cells.length).fill(-1)
  reachableIndices.forEach((index, order) => {
    orderByIndex[index] = order
  })

  const cells: WaterCellSchedule[] = graph.cells.map((cell) => {
    const reachable = cell.active && Number.isFinite(arrivals[cell.index])
    const side = sideStorage.get(cell.index)
    const peakLevel = reachable
      ? side?.peakLevel ??
        (cell.index === sourceIndex ? 1 : options.flowPeakLevel)
      : 0
    const isDeadEnd =
      cell.active &&
      cell.index !== sourceIndex &&
      cell.index !== exitIndex &&
      getPassageNeighbors(graph, cell).length <= 1
    let drainage: WaterDrainage = 'unreachable'
    let retainedLevel = 0
    if (reachable) {
      if (cell.index === exitIndex && reachedExit) {
        drainage = 'exit'
        retainedLevel = Math.min(peakLevel, options.steadyFlowLevel)
      } else if (backbone.has(cell.index) || canDrain.has(cell.index)) {
        drainage = 'drains'
        retainedLevel = Math.min(peakLevel, options.steadyFlowLevel)
      } else {
        drainage = 'pools'
        retainedLevel = Math.min(peakLevel, options.pooledLevel)
      }
    }
    const arrivalMs = reachable ? roundTime(arrivals[cell.index]) : null
    const fillScale = clamp(
      peakLevel / Math.max(options.flowPeakLevel, EPSILON),
      0.25,
      1,
    )
    return {
      index: cell.index,
      position: { row: cell.row, col: cell.col },
      active: cell.active,
      reachable,
      arrivalMs,
      depth: reachable ? depths[cell.index] : null,
      branch: reachable ? branches[cell.index] : null,
      order: reachable ? orderByIndex[cell.index] : null,
      incomingIndex:
        reachable && parents[cell.index] >= 0 ? parents[cell.index] : null,
      incomingDirection: reachable
        ? incomingDirections[cell.index]
        : null,
      isDeadEnd,
      drainage,
      peakLevel,
      retainedLevel,
      fullMs:
        arrivalMs === null
          ? null
          : roundTime(arrivalMs + options.cellFillMs * fillScale),
    }
  })

  const segments: WaterFlowSegment[] = cells
    .filter(
      (
        cell,
      ): cell is WaterCellSchedule & {
        arrivalMs: number
        depth: number
        branch: number
        incomingIndex: number
        incomingDirection: WallDirection
      } =>
        cell.reachable &&
        cell.arrivalMs !== null &&
        cell.depth !== null &&
        cell.branch !== null &&
        cell.incomingIndex !== null &&
        cell.incomingDirection !== null,
    )
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map((cell) => {
      const parent = cells[cell.incomingIndex]
      return {
        fromIndex: parent.index,
        toIndex: cell.index,
        from: { ...parent.position },
        to: { ...cell.position },
        direction: cell.incomingDirection,
        departureMs: parent.fullMs ?? 0,
        arrivalMs: cell.arrivalMs,
        depth: cell.depth,
        branch: cell.branch,
      }
    })

  const latestFullMs = cells.reduce(
    (latest, cell) => Math.max(latest, cell.fullMs ?? 0),
    0,
  )
  const globalDrainStart =
    exitArrivalMs === null
      ? latestFullMs
      : exitArrivalMs + options.drainDelayMs
  const totalDurationMs = roundTime(
    reachedExit
      ? Math.max(latestFullMs, globalDrainStart) + options.drainDurationMs
      : latestFullMs,
  )

  return {
    sourceIndex,
    exitIndex,
    source: { ...start },
    exit: { ...end },
    cells,
    segments,
    totalDurationMs,
    exitArrivalMs,
    reachedExit,
    options,
  }
}

function sampleCell(
  model: WaterSimulationModel,
  cell: WaterCellSchedule,
  elapsedMs: number,
): WaterCellFrame {
  const base = {
    index: cell.index,
    position: { ...cell.position },
  }
  if (
    !cell.reachable ||
    cell.arrivalMs === null ||
    cell.fullMs === null ||
    elapsedMs < cell.arrivalMs
  ) {
    return { ...base, level: 0, state: 'dry' }
  }
  if (elapsedMs < cell.fullMs) {
    return {
      ...base,
      level:
        cell.peakLevel *
        clamp(
          (elapsedMs - cell.arrivalMs) / (cell.fullMs - cell.arrivalMs),
          0,
          1,
        ),
      state: 'filling',
    }
  }
  if (!model.reachedExit || model.exitArrivalMs === null) {
    return { ...base, level: cell.peakLevel, state: 'pooled' }
  }

  const drainStart = Math.max(
    cell.fullMs,
    model.exitArrivalMs + model.options.drainDelayMs,
  )
  if (elapsedMs < drainStart) {
    return {
      ...base,
      level: cell.peakLevel,
      state: cell.drainage === 'exit' ? 'outlet' : 'flowing',
    }
  }

  const drainProgress = clamp(
    (elapsedMs - drainStart) / model.options.drainDurationMs,
    0,
    1,
  )
  const level =
    cell.peakLevel -
    (cell.peakLevel - cell.retainedLevel) * drainProgress
  if (cell.drainage === 'exit') {
    return { ...base, level, state: 'outlet' }
  }
  if (cell.drainage === 'pools') {
    return { ...base, level, state: 'pooled' }
  }
  if (drainProgress < 1) {
    return { ...base, level, state: 'draining' }
  }
  return { ...base, level: cell.retainedLevel, state: 'wet' }
}

/** Samples per-cell animation levels without mutating the reusable model. */
export function sampleWaterSimulation(
  model: WaterSimulationModel,
  elapsedMs: number,
): WaterSimulationFrame {
  const time = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0)
  return {
    elapsedMs: time,
    progress:
      model.totalDurationMs === 0
        ? 1
        : clamp(time / model.totalDurationMs, 0, 1),
    reachedExit:
      model.exitArrivalMs !== null && time >= model.exitArrivalMs,
    cells: model.cells.map((cell) => sampleCell(model, cell, time)),
  }
}
