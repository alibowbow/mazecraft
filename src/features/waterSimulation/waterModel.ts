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
  /** Milliseconds needed to cross one open passage after a basin has filled. */
  upwardTravelMs?: number
  /** Milliseconds needed for the source to supply one wetting increment. */
  cellFillMs?: number
  /** Pause after the exit is reached before drain-down begins. */
  drainDelayMs?: number
  /** Time for drainable cells to settle to their retained level. */
  drainDurationMs?: number
  /** Thin film left in corridors that can drain to the exit. */
  residualFilmLevel?: number
  /** Stable depth maintained in passages carrying continuous flow. */
  steadyFlowLevel?: number
  /** Maximum depth retained in a gravity basin after breakthrough. */
  pooledLevel?: number
  /** Smallest conserved volume deposited when a passage first becomes wet. */
  minimumWetLevel?: number
  /**
   * Require the source and exit to occupy the topmost and bottommost active
   * rows. This defaults to true because the visual experiment pours vertically.
   */
  enforceVerticalEndpoints?: boolean
}

export interface ResolvedWaterSimulationOptions {
  downwardTravelMs: number
  horizontalTravelMs: number
  upwardTravelMs: number
  cellFillMs: number
  drainDelayMs: number
  drainDurationMs: number
  residualFilmLevel: number
  steadyFlowLevel: number
  pooledLevel: number
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
  /** True only when conserved source volume actually reaches this cell. */
  reachable: boolean
  /** First contact with the water front. Null for dry cells. */
  arrivalMs: number | null
  /** Time at which this cell reaches its peak simulated level. */
  fullMs: number | null
  /** Edge depth in the deterministic first-contact tree. */
  depth: number | null
  /** Stable branch identifier used only for rendering variation. */
  branch: number | null
  /** Stable total ordering for equal-time rendering and particle emission. */
  order: number | null
  incomingIndex: number | null
  incomingDirection: WallDirection | null
  isDeadEnd: boolean
  drainage: WaterDrainage
  /** Greatest conserved fluid depth reached before outlet breakthrough. */
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

export interface WaterMassBalance {
  /** Volume supplied before the first stable outlet path is established. */
  injectedBeforeBreakthrough: number
  /** Volume held by all wet cells at breakthrough. */
  storedAtBreakthrough: number
  /** Volume released while drainable cells settle. */
  drainedDuringSettle: number
  /** Volume remaining as through-flow film or trapped basin water. */
  retainedAfterSettle: number
  /** Absolute conservation error; expected to remain at floating-point noise. */
  conservationError: number
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
  massBalance: WaterMassBalance
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

interface HydraulicEntry {
  index: number
  head: number
}

interface FrontEntry {
  index: number
  parentIndex: number
  direction: WallDirection | null
  readyMs: number
}

interface HydraulicFillResult {
  arrivals: number[]
  fullTimes: number[]
  depths: Int32Array
  parents: Int32Array
  incomingDirections: Array<WallDirection | null>
  volumes: Float64Array
  injectedVolume: number
  exitArrivalMs: number | null
}

const DEFAULT_OPTIONS: ResolvedWaterSimulationOptions = {
  downwardTravelMs: 90,
  horizontalTravelMs: 190,
  upwardTravelMs: 540,
  cellFillMs: 120,
  drainDelayMs: 320,
  drainDurationMs: 900,
  residualFilmLevel: 0.06,
  steadyFlowLevel: 0.34,
  pooledLevel: 0.92,
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

const roundVolume = (value: number): number =>
  Math.round((value + Number.EPSILON) * 1_000_000_000) / 1_000_000_000

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
  assertFiniteInRange('drainDelayMs', options.drainDelayMs, 0)
  assertFiniteInRange('drainDurationMs', options.drainDurationMs, 1)
  assertFiniteInRange('residualFilmLevel', options.residualFilmLevel, 0, 1)
  assertFiniteInRange('steadyFlowLevel', options.steadyFlowLevel, 0, 1)
  assertFiniteInRange('pooledLevel', options.pooledLevel, 0, 1)
  assertFiniteInRange('minimumWetLevel', options.minimumWetLevel, 0.01, 0.5)
  if (options.pooledLevel < options.residualFilmLevel) {
    throw new RangeError(
      'pooledLevel must be greater than or equal to residualFilmLevel.',
    )
  }
  if (options.steadyFlowLevel < options.residualFilmLevel) {
    throw new RangeError(
      'steadyFlowLevel must be greater than or equal to residualFilmLevel.',
    )
  }
  return options
}

class BinaryHeap<T> {
  private readonly values: T[] = []

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get size(): number {
    return this.values.length
  }

  peek(): T | undefined {
    return this.values[0]
  }

  push(value: T): void {
    this.values.push(value)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.compare(this.values[parent], this.values[index]) <= 0) break
      ;[this.values[parent], this.values[index]] = [
        this.values[index],
        this.values[parent],
      ]
      index = parent
    }
  }

  pop(): T | undefined {
    const first = this.values[0]
    const last = this.values.pop()
    if (!first || !last) return first
    if (this.values.length === 0) return first
    this.values[0] = last
    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if (
        left < this.values.length &&
        this.compare(this.values[left], this.values[smallest]) < 0
      ) {
        smallest = left
      }
      if (
        right < this.values.length &&
        this.compare(this.values[right], this.values[smallest]) < 0
      ) {
        smallest = right
      }
      if (smallest === index) break
      ;[this.values[index], this.values[smallest]] = [
        this.values[smallest],
        this.values[index],
      ]
      index = smallest
    }
    return first
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

function compareFrontEntries(left: FrontEntry, right: FrontEntry): number {
  if (Math.abs(left.readyMs - right.readyMs) > EPSILON) {
    return left.readyMs - right.readyMs
  }
  const leftPriority = left.direction === null
    ? -1
    : DIRECTION_PRIORITY[left.direction]
  const rightPriority = right.direction === null
    ? -1
    : DIRECTION_PRIORITY[right.direction]
  if (leftPriority !== rightPriority) return leftPriority - rightPriority
  if (left.parentIndex !== right.parentIndex) {
    return left.parentIndex - right.parentIndex
  }
  return left.index - right.index
}

/**
 * Conserved finite-volume fill solver.
 *
 * A newly wet cell consumes one explicit volume increment. Water may fan out
 * through every open downward or level passage immediately, but an upward
 * passage is not exposed until the lower cell reaches a full unit of head.
 * The minimum-head heap raises every cell at the same or lower hydraulic head
 * together, removing array-order and preselected-route bias.
 */
function calculateHydraulicFill(
  graph: MazeGraph,
  sourceIndex: number,
  exitIndex: number,
  options: ResolvedWaterSimulationOptions,
): HydraulicFillResult {
  const cellCount = graph.cells.length
  const arrivals = new Array<number>(cellCount).fill(Number.POSITIVE_INFINITY)
  const fullTimes = new Array<number>(cellCount).fill(Number.POSITIVE_INFINITY)
  const depths = new Int32Array(cellCount)
  depths.fill(-1)
  const parents = new Int32Array(cellCount)
  parents.fill(-1)
  const incomingDirections = new Array<WallDirection | null>(cellCount).fill(
    null,
  )
  const volumes = new Float64Array(cellCount)
  const wet = new Uint8Array(cellCount)
  const hydraulicHeap = new BinaryHeap<HydraulicEntry>((left, right) => {
    if (Math.abs(left.head - right.head) > EPSILON) {
      return left.head - right.head
    }
    return left.index - right.index
  })
  const wettingIncrement = options.minimumWetLevel
  let clockMs = 0
  let injectedVolume = 0
  let exitArrivalMs: number | null = null

  const elevation = (index: number) =>
    graph.rows - 1 - graph.cells[index].row
  const hydraulicHead = (index: number) => elevation(index) + volumes[index]
  const pushHydraulicCell = (index: number) => {
    if (volumes[index] >= 1 - EPSILON) return
    hydraulicHeap.push({ index, head: hydraulicHead(index) })
  }

  const spreadWithoutClimbing = (seeds: readonly FrontEntry[]): void => {
    const front = new BinaryHeap<FrontEntry>(compareFrontEntries)
    for (const seed of seeds) front.push(seed)

    while (front.size > 0) {
      let first = front.pop()
      while (first && wet[first.index]) first = front.pop()
      if (!first) break

      const waveReadyMs = first.readyMs
      const candidates = new Map<number, FrontEntry>([[first.index, first]])
      while (front.size > 0) {
        const next = front.peek()
        if (!next || next.readyMs > waveReadyMs + EPSILON) break
        const candidate = front.pop()
        if (!candidate || wet[candidate.index]) continue
        const previous = candidates.get(candidate.index)
        if (!previous || compareFrontEntries(candidate, previous) < 0) {
          candidates.set(candidate.index, candidate)
        }
      }

      const wave = [...candidates.values()].sort(compareFrontEntries)
      const waveArrivalMs = Math.max(clockMs, waveReadyMs)
      const newlyWet: number[] = []
      let supplied = 0
      for (const candidate of wave) {
        if (wet[candidate.index]) continue
        const amount = Math.min(wettingIncrement, 1)
        wet[candidate.index] = 1
        volumes[candidate.index] = amount
        arrivals[candidate.index] = waveArrivalMs
        parents[candidate.index] = candidate.parentIndex
        incomingDirections[candidate.index] = candidate.direction
        depths[candidate.index] = candidate.parentIndex < 0
          ? 0
          : depths[candidate.parentIndex] + 1
        supplied += amount
        newlyWet.push(candidate.index)
        if (candidate.index === exitIndex && exitArrivalMs === null) {
          exitArrivalMs = roundTime(waveArrivalMs)
        }
      }
      if (newlyWet.length === 0) continue

      const supplyDurationMs =
        (supplied / wettingIncrement) * options.cellFillMs
      clockMs = waveArrivalMs + supplyDurationMs
      injectedVolume += supplied
      for (const index of newlyWet) {
        fullTimes[index] = clockMs
        pushHydraulicCell(index)
      }

      for (const index of newlyWet) {
        const cell = graph.cells[index]
        for (const { direction, cell: neighbor } of getPassageNeighbors(
          graph,
          cell,
        )) {
          if (wet[neighbor.index] || neighbor.row < cell.row) continue
          front.push({
            index: neighbor.index,
            parentIndex: index,
            direction,
            readyMs:
              fullTimes[index] + travelTimeForDirection(direction, options),
          })
        }
      }
    }
  }

  spreadWithoutClimbing([
    {
      index: sourceIndex,
      parentIndex: -1,
      direction: null,
      readyMs: 0,
    },
  ])

  const maximumDeposits =
    graph.cells.filter((cell) => cell.active).length *
    (Math.ceil(1 / wettingIncrement) + 2)
  let depositCount = wet.reduce((total, value) => total + value, 0)

  while (exitArrivalMs === null && hydraulicHeap.size > 0) {
    let first = hydraulicHeap.pop()
    while (
      first &&
      (volumes[first.index] >= 1 - EPSILON ||
        Math.abs(first.head - hydraulicHead(first.index)) > EPSILON)
    ) {
      first = hydraulicHeap.pop()
    }
    if (!first) break

    const targetHead = first.head
    const group = [first.index]
    while (hydraulicHeap.size > 0) {
      const next = hydraulicHeap.peek()
      if (!next) break
      if (
        volumes[next.index] >= 1 - EPSILON ||
        Math.abs(next.head - hydraulicHead(next.index)) > EPSILON
      ) {
        hydraulicHeap.pop()
        continue
      }
      if (next.head > targetHead + EPSILON) break
      const entry = hydraulicHeap.pop()
      if (entry) group.push(entry.index)
    }

    let supplied = 0
    const newlyFull: number[] = []
    for (const index of group) {
      const amount = Math.min(wettingIncrement, 1 - volumes[index])
      if (amount <= EPSILON) continue
      volumes[index] += amount
      supplied += amount
      depositCount += 1
      if (volumes[index] >= 1 - EPSILON) {
        volumes[index] = 1
        newlyFull.push(index)
      }
    }
    if (supplied <= EPSILON) continue
    if (depositCount > maximumDeposits) {
      throw new Error('Hydraulic solver exceeded its conserved-volume bound.')
    }

    clockMs += (supplied / wettingIncrement) * options.cellFillMs
    injectedVolume += supplied
    for (const index of group) {
      fullTimes[index] = clockMs
      pushHydraulicCell(index)
    }

    const upwardFronts: FrontEntry[] = []
    for (const index of newlyFull) {
      const cell = graph.cells[index]
      for (const { direction, cell: neighbor } of getPassageNeighbors(
        graph,
        cell,
      )) {
        if (wet[neighbor.index] || neighbor.row >= cell.row) continue
        upwardFronts.push({
          index: neighbor.index,
          parentIndex: index,
          direction,
          readyMs: clockMs + travelTimeForDirection(direction, options),
        })
      }
    }
    if (upwardFronts.length > 0) spreadWithoutClimbing(upwardFronts)
  }

  return {
    arrivals,
    fullTimes,
    depths,
    parents,
    incomingDirections,
    volumes,
    injectedVolume: roundVolume(injectedVolume),
    exitArrivalMs,
  }
}

function collectExitRoute(
  parents: ArrayLike<number>,
  exitIndex: number,
): Set<number> {
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
  parents: ArrayLike<number>,
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
      branches[child] = childOrder === 0 ? branches[parent] : nextBranch++
      queue.push(child)
    })
  }
  return branches
}

/**
 * Marks cells that can reach the bottom exit without ever moving upward.
 * Wet cells outside this set form gravity basins and retain pooled water.
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
 * Builds a deterministic, mass-conserving hydraulic model without consulting
 * or preselecting the maze solution. Every transition follows a real open
 * passage; lower and level storage equalizes before any upward spill.
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
  const fill = calculateHydraulicFill(
    graph,
    sourceIndex,
    exitIndex,
    options,
  )
  const reachedExit = fill.exitArrivalMs !== null
  const exitRoute = reachedExit
    ? collectExitRoute(fill.parents, exitIndex)
    : new Set<number>([sourceIndex])
  const branches = assignBranches(
    graph,
    sourceIndex,
    fill.arrivals,
    fill.parents,
    fill.incomingDirections,
    exitRoute,
  )
  const canDrain = reachedExit
    ? calculateGravityDrainage(graph, exitIndex)
    : new Set<number>()

  const reachableIndices = graph.cells
    .filter((cell) => cell.active && Number.isFinite(fill.arrivals[cell.index]))
    .map((cell) => cell.index)
    .sort((left, right) => {
      const arrivalDifference = fill.arrivals[left] - fill.arrivals[right]
      if (Math.abs(arrivalDifference) > EPSILON) return arrivalDifference
      return left - right
    })
  const orderByIndex = new Int32Array(graph.cells.length)
  orderByIndex.fill(-1)
  reachableIndices.forEach((index, order) => {
    orderByIndex[index] = order
  })

  const cells: WaterCellSchedule[] = graph.cells.map((cell) => {
    const reachable = cell.active && Number.isFinite(fill.arrivals[cell.index])
    const peakLevel = reachable ? roundVolume(fill.volumes[cell.index]) : 0
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
      } else if (canDrain.has(cell.index)) {
        drainage = 'drains'
        retainedLevel = Math.min(peakLevel, options.steadyFlowLevel)
      } else {
        drainage = 'pools'
        retainedLevel = Math.min(peakLevel, options.pooledLevel)
      }
    }
    return {
      index: cell.index,
      position: { row: cell.row, col: cell.col },
      active: cell.active,
      reachable,
      arrivalMs: reachable ? roundTime(fill.arrivals[cell.index]) : null,
      fullMs: reachable ? roundTime(fill.fullTimes[cell.index]) : null,
      depth: reachable ? fill.depths[cell.index] : null,
      branch: reachable ? branches[cell.index] : null,
      order: reachable ? orderByIndex[cell.index] : null,
      incomingIndex:
        reachable && fill.parents[cell.index] >= 0
          ? fill.parents[cell.index]
          : null,
      incomingDirection: reachable
        ? fill.incomingDirections[cell.index]
        : null,
      isDeadEnd,
      drainage,
      peakLevel,
      retainedLevel: roundVolume(retainedLevel),
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
  const globalDrainStart = reachedExit
    ? Math.max(latestFullMs, (fill.exitArrivalMs ?? 0) + options.drainDelayMs)
    : latestFullMs
  const totalDurationMs = roundTime(
    reachedExit ? globalDrainStart + options.drainDurationMs : latestFullMs,
  )
  const storedAtBreakthrough = roundVolume(
    cells.reduce((total, cell) => total + cell.peakLevel, 0),
  )
  const retainedAfterSettle = roundVolume(
    cells.reduce((total, cell) => total + cell.retainedLevel, 0),
  )
  const drainedDuringSettle = roundVolume(
    Math.max(0, storedAtBreakthrough - retainedAfterSettle),
  )
  const conservationError = roundVolume(
    Math.abs(
      fill.injectedVolume -
        (retainedAfterSettle + drainedDuringSettle),
    ),
  )

  return {
    sourceIndex,
    exitIndex,
    source: { ...start },
    exit: { ...end },
    cells,
    segments,
    totalDurationMs,
    exitArrivalMs: fill.exitArrivalMs,
    reachedExit,
    massBalance: {
      injectedBeforeBreakthrough: fill.injectedVolume,
      storedAtBreakthrough,
      drainedDuringSettle,
      retainedAfterSettle,
      conservationError,
    },
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
          (elapsedMs - cell.arrivalMs) /
            Math.max(EPSILON, cell.fullMs - cell.arrivalMs),
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
