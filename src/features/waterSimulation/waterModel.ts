import {
  directionBetween,
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
  /** Water retained in a basin that would need to climb to escape. */
  pooledLevel?: number
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
  pooledLevel: number
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
  pooledLevel: 0.92,
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
  assertFiniteInRange('pooledLevel', options.pooledLevel, 0, 1)
  if (options.pooledLevel < options.residualFilmLevel) {
    throw new RangeError(
      'pooledLevel must be greater than or equal to residualFilmLevel.',
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
    const passageNeighbors = getPassageNeighbors(graph, currentCell)
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
 * Builds a deterministic, graph-only water propagation model. It does not use
 * the maze solution and intentionally visits every corridor reachable from the
 * source. The resulting schedules are suitable for particles, instanced water
 * meshes, shaders, or a 2D fallback renderer.
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
  const { arrivals, depths, parents, incomingDirections } =
    calculateArrivalTree(graph, sourceIndex, options)
  const reachedExit = Number.isFinite(arrivals[exitIndex])
  const exitArrivalMs = reachedExit ? roundTime(arrivals[exitIndex]) : null
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
      } else if (canDrain.has(cell.index)) {
        drainage = 'drains'
        retainedLevel = options.residualFilmLevel
      } else {
        drainage = 'pools'
        retainedLevel = options.pooledLevel
      }
    }
    const arrivalMs = reachable ? roundTime(arrivals[cell.index]) : null
    return {
      index: cell.index,
      position: { row: cell.row, col: cell.col },
      active: cell.active,
      reachable,
      arrivalMs,
      fullMs:
        arrivalMs === null ? null : roundTime(arrivalMs + options.cellFillMs),
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
      retainedLevel,
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
      level: clamp(
        (elapsedMs - cell.arrivalMs) / (cell.fullMs - cell.arrivalMs),
        0,
        1,
      ),
      state: 'filling',
    }
  }
  if (!model.reachedExit || model.exitArrivalMs === null) {
    return { ...base, level: 1, state: 'pooled' }
  }

  const drainStart = Math.max(
    cell.fullMs,
    model.exitArrivalMs + model.options.drainDelayMs,
  )
  if (elapsedMs < drainStart) {
    return {
      ...base,
      level: 1,
      state: cell.drainage === 'exit' ? 'outlet' : 'flowing',
    }
  }

  const drainProgress = clamp(
    (elapsedMs - drainStart) / model.options.drainDurationMs,
    0,
    1,
  )
  const level = 1 - (1 - cell.retainedLevel) * drainProgress
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
