import {
  DEFAULT_OUTLET_BOUNDARY,
  DEFAULT_PRESCRIBED_INFLOW,
  outletDischarge as evaluateOutletDischarge,
  prescribedRampInflow,
  type OutletBoundary,
  type PrescribedInflowBoundary,
} from './boundaries'
import type { HydraulicNetwork } from './network'

export interface HydraulicSolverOptions {
  physicsStepSeconds?: number
  maxSubstepsPerAdvance?: number
  source?: Partial<PrescribedInflowBoundary>
  outlet?: Partial<OutletBoundary>
  initialVolumes?: ArrayLike<number>
  /** Linear edge damping, inverse seconds. */
  dampingCoefficient?: number
  /** Absolute Q below which a closed portal is put to rest. */
  flowEpsilon?: number
  /** Velocity used by active-flow diagnostics. */
  activeFlowThreshold?: number
  /** Maximum fraction of a node's available water released in one substep. */
  maxOutflowFraction?: number
  /** Absolute safety ceiling for reduced-order edge velocity. */
  maximumVelocityMetersPerSecond?: number
  /** Depth-aware shallow-water velocity ceiling, expressed as a Froude number. */
  maximumFroudeNumber?: number
}

export interface ResolvedHydraulicSolverOptions {
  physicsStepSeconds: number
  maxSubstepsPerAdvance: number
  source: PrescribedInflowBoundary
  outlet: OutletBoundary
  dampingCoefficient: number
  flowEpsilon: number
  activeFlowThreshold: number
  maxOutflowFraction: number
  maximumVelocityMetersPerSecond: number
  maximumFroudeNumber: number
}

export interface HydraulicState {
  readonly volume: Float64Array
  readonly depth: Float64Array
  readonly hydraulicHead: Float64Array
  readonly netInflow: Float64Array
  readonly pressureProxy: Float64Array
  readonly discharge: Float64Array
  readonly velocity: Float64Array
  readonly openingArea: Float64Array
  readonly cumulativeSignedVolume: Float64Array
  readonly cumulativeAbsoluteVolume: Float64Array
}

export interface HydraulicSolver {
  readonly network: HydraulicNetwork
  readonly options: ResolvedHydraulicSolverOptions
  readonly state: HydraulicState
  simulationTime: number
  accumulatorSeconds: number
  initialStoredVolume: number
  cumulativeInjectedVolume: number
  cumulativeOutletVolume: number
  outletDischarge: number
  readonly activeFlowThreshold: number
  readonly scratch: {
    readonly candidateDischarge: Float64Array
    readonly outwardRate: Float64Array
    readonly limiter: Float64Array
  }
}

export interface EdgeMomentumStepInput {
  /** Signed discharge before this substep. */
  discharge: number
  /** Pressure/gravity forcing in discharge units per second. */
  acceleration: number
  /** Linear damping coefficient, inverse seconds. */
  linearDamping: number
  /** Quadratic drag coefficient applied to q|q|. */
  quadraticResistance: number
  deltaSeconds: number
}

const DEFAULT_STEP_SECONDS = 1 / 120
const DEFAULT_MAXIMUM_FROUDE_NUMBER = 2.4

function requirePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`)
  }
}

function requireNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`)
  }
}

function integrateEdgeMomentumImplicitUnchecked(
  discharge: number,
  acceleration: number,
  linearDamping: number,
  quadraticResistance: number,
  deltaSeconds: number,
): number {
  // Pressure/gravity is explicit; linear and quadratic drag are backward Euler.
  // Solving R*dt*q^2 + (1 + lambda*dt)*q - |q*| = 0 avoids the
  // sign-flipping overshoot of a fully explicit q|q| term.
  const forcedDischarge = discharge + acceleration * deltaSeconds
  const forcedMagnitude = Math.abs(forcedDischarge)
  if (forcedMagnitude <= Number.EPSILON) return 0
  const linearFactor = 1 + linearDamping * deltaSeconds
  if (quadraticResistance <= Number.EPSILON) {
    return Math.sign(forcedDischarge) * (forcedMagnitude / linearFactor)
  }
  const discriminant =
    linearFactor * linearFactor +
    4 * quadraticResistance * deltaSeconds * forcedMagnitude
  const magnitude =
    (2 * forcedMagnitude) /
    (linearFactor + Math.sqrt(discriminant))
  return Math.sign(forcedDischarge) * magnitude
}

/**
 * Advances one edge momentum state with implicit drag. The result cannot change
 * sign from drag alone and remains finite for large resistance or time steps.
 */
export function integrateEdgeMomentumImplicit(
  input: EdgeMomentumStepInput,
): number {
  if (!Number.isFinite(input.discharge)) {
    throw new RangeError('discharge must be finite.')
  }
  if (!Number.isFinite(input.acceleration)) {
    throw new RangeError('acceleration must be finite.')
  }
  requireNonNegativeFinite('linearDamping', input.linearDamping)
  requireNonNegativeFinite('quadraticResistance', input.quadraticResistance)
  requirePositiveFinite('deltaSeconds', input.deltaSeconds)
  return integrateEdgeMomentumImplicitUnchecked(
    input.discharge,
    input.acceleration,
    input.linearDamping,
    input.quadraticResistance,
    input.deltaSeconds,
  )
}

/** Extra drag applied to thin films where hydraulic radius is smallest. */
export function resolveShallowWaterResistanceMultiplier(
  openingFraction: number,
): number {
  if (
    !Number.isFinite(openingFraction) ||
    openingFraction < 0 ||
    openingFraction > 1
  ) {
    throw new RangeError('openingFraction must be in the range [0, 1].')
  }
  const shallowFraction = 1 - openingFraction
  return 1 + 2.25 * shallowFraction * shallowFraction
}

function resolveShallowWaterVelocityLimitUnchecked(
  gravityMetersPerSecondSquared: number,
  depthMeters: number,
  absoluteLimitMetersPerSecond: number,
  maximumFroudeNumber: number,
): number {
  if (depthMeters <= 0) return 0
  const gravityWaveSpeed = Math.sqrt(
    gravityMetersPerSecondSquared * depthMeters,
  )
  return Math.min(
    absoluteLimitMetersPerSecond,
    maximumFroudeNumber * gravityWaveSpeed,
  )
}

/** Depth-aware velocity cap used for stable wetting and drying fronts. */
export function resolveShallowWaterVelocityLimit(
  gravityMetersPerSecondSquared: number,
  depthMeters: number,
  absoluteLimitMetersPerSecond: number,
  maximumFroudeNumber = DEFAULT_MAXIMUM_FROUDE_NUMBER,
): number {
  requirePositiveFinite(
    'gravityMetersPerSecondSquared',
    gravityMetersPerSecondSquared,
  )
  requireNonNegativeFinite('depthMeters', depthMeters)
  requirePositiveFinite(
    'absoluteLimitMetersPerSecond',
    absoluteLimitMetersPerSecond,
  )
  requirePositiveFinite('maximumFroudeNumber', maximumFroudeNumber)
  return resolveShallowWaterVelocityLimitUnchecked(
    gravityMetersPerSecondSquared,
    depthMeters,
    absoluteLimitMetersPerSecond,
    maximumFroudeNumber,
  )
}

function sum(values: ArrayLike<number>): number {
  let total = 0
  for (let index = 0; index < values.length; index += 1) total += values[index]
  return total
}

function resolveOptions(
  network: HydraulicNetwork,
  input: HydraulicSolverOptions,
): ResolvedHydraulicSolverOptions {
  const physicsStepSeconds = input.physicsStepSeconds ?? DEFAULT_STEP_SECONDS
  const maxSubstepsPerAdvance = input.maxSubstepsPerAdvance ?? 20_000
  const dampingCoefficient = input.dampingCoefficient ?? 2.4
  const flowEpsilon = input.flowEpsilon ?? 1e-10
  const activeFlowThreshold = input.activeFlowThreshold ?? 1e-4
  const maxOutflowFraction = input.maxOutflowFraction ?? 0.92
  const maximumVelocityMetersPerSecond =
    input.maximumVelocityMetersPerSecond ?? 7.5
  const maximumFroudeNumber =
    input.maximumFroudeNumber ?? DEFAULT_MAXIMUM_FROUDE_NUMBER
  requirePositiveFinite('physicsStepSeconds', physicsStepSeconds)
  if (!Number.isInteger(maxSubstepsPerAdvance) || maxSubstepsPerAdvance < 1) {
    throw new RangeError('maxSubstepsPerAdvance must be a positive integer.')
  }
  requireNonNegativeFinite('dampingCoefficient', dampingCoefficient)
  requireNonNegativeFinite('flowEpsilon', flowEpsilon)
  requireNonNegativeFinite('activeFlowThreshold', activeFlowThreshold)
  if (
    !Number.isFinite(maxOutflowFraction) ||
    maxOutflowFraction <= 0 ||
    maxOutflowFraction > 1
  ) {
    throw new RangeError('maxOutflowFraction must be in the range (0, 1].')
  }
  requirePositiveFinite(
    'maximumVelocityMetersPerSecond',
    maximumVelocityMetersPerSecond,
  )
  requirePositiveFinite('maximumFroudeNumber', maximumFroudeNumber)

  const source: PrescribedInflowBoundary = {
    ...DEFAULT_PRESCRIBED_INFLOW,
    ...input.source,
  }
  const outlet: OutletBoundary = {
    ...DEFAULT_OUTLET_BOUNDARY,
    boundaryHeadMeters: network.elevation[network.outletNode],
    gravityMetersPerSecondSquared:
      network.geometry.gravityMetersPerSecondSquared,
    ...input.outlet,
  }
  return {
    physicsStepSeconds,
    maxSubstepsPerAdvance,
    source,
    outlet,
    dampingCoefficient,
    flowEpsilon,
    activeFlowThreshold,
    maxOutflowFraction,
    maximumVelocityMetersPerSecond,
    maximumFroudeNumber,
  }
}

function writeInitialVolumes(
  solver: HydraulicSolver,
  values?: ArrayLike<number>,
): void {
  const { volume } = solver.state
  volume.fill(0)
  if (!values) return
  if (values.length !== volume.length) {
    throw new RangeError('initialVolumes must contain one value per active node.')
  }
  for (let node = 0; node < volume.length; node += 1) {
    const value = Number(values[node])
    requireNonNegativeFinite(`initialVolumes[${node}]`, value)
    volume[node] = value
  }
}

function updateNodeDerivedState(solver: HydraulicSolver): void {
  const { network, state } = solver
  for (let node = 0; node < network.nodeCount; node += 1) {
    const depth = state.volume[node] / network.storageArea[node]
    state.depth[node] = depth
    state.hydraulicHead[node] = network.elevation[node] + depth
    state.pressureProxy[node] =
      network.geometry.gravityMetersPerSecondSquared * depth
  }
}

export function createHydraulicSolver(
  network: HydraulicNetwork,
  input: HydraulicSolverOptions = {},
): HydraulicSolver {
  const options = resolveOptions(network, input)
  const state: HydraulicState = {
    volume: new Float64Array(network.nodeCount),
    depth: new Float64Array(network.nodeCount),
    hydraulicHead: new Float64Array(network.nodeCount),
    netInflow: new Float64Array(network.nodeCount),
    pressureProxy: new Float64Array(network.nodeCount),
    discharge: new Float64Array(network.edgeCount),
    velocity: new Float64Array(network.edgeCount),
    openingArea: new Float64Array(network.edgeCount),
    cumulativeSignedVolume: new Float64Array(network.edgeCount),
    cumulativeAbsoluteVolume: new Float64Array(network.edgeCount),
  }
  const solver: HydraulicSolver = {
    network,
    options,
    state,
    simulationTime: 0,
    accumulatorSeconds: 0,
    initialStoredVolume: 0,
    cumulativeInjectedVolume: 0,
    cumulativeOutletVolume: 0,
    outletDischarge: 0,
    activeFlowThreshold: options.activeFlowThreshold,
    scratch: {
      candidateDischarge: new Float64Array(network.edgeCount),
      outwardRate: new Float64Array(network.nodeCount),
      limiter: new Float64Array(network.nodeCount),
    },
  }
  writeInitialVolumes(solver, input.initialVolumes)
  solver.initialStoredVolume = sum(state.volume)
  updateNodeDerivedState(solver)
  return solver
}

function advanceOneSubstep(solver: HydraulicSolver, dt: number): void {
  const { network, options, state, scratch } = solver
  updateNodeDerivedState(solver)
  scratch.outwardRate.fill(0)
  scratch.limiter.fill(1)
  state.netInflow.fill(0)

  const gravity = network.geometry.gravityMetersPerSecondSquared
  const absoluteMaxVelocity = options.maximumVelocityMetersPerSecond
  for (let edge = 0; edge < network.edgeCount; edge += 1) {
    const from = network.edgeFrom[edge]
    const to = network.edgeTo[edge]
    const headDifference =
      state.hydraulicHead[from] - state.hydraulicHead[to]
    const upstream =
      headDifference > 0
        ? from
        : headDifference < 0
          ? to
          : state.discharge[edge] >= 0
            ? from
            : to
    const submergedDepth = Math.min(
      network.edgeMaxOpeningDepth[edge],
      Math.max(
        0,
        state.hydraulicHead[upstream] - network.edgeSillElevation[edge],
      ),
    )
    const area = network.edgeWidth[edge] * submergedDepth
    state.openingArea[edge] = area
    let nextDischarge = state.discharge[edge]
    if (area <= 1e-12) {
      nextDischarge *= Math.exp(-18 * dt)
      if (Math.abs(nextDischarge) < options.flowEpsilon) nextDischarge = 0
    } else {
      const acceleration =
        (gravity * area * headDifference) / network.edgeLength[edge]
      const fullOpeningArea =
        network.edgeWidth[edge] * network.edgeMaxOpeningDepth[edge]
      const openingFraction = Math.max(
        0,
        Math.min(1, area / Math.max(fullOpeningArea, 1e-12)),
      )
      const shallowFraction = 1 - openingFraction
      const resistanceMultiplier =
        1 + 2.25 * shallowFraction * shallowFraction
      nextDischarge = integrateEdgeMomentumImplicitUnchecked(
        nextDischarge,
        acceleration,
        options.dampingCoefficient,
        network.edgeResistance[edge] * resistanceMultiplier,
        dt,
      )
      const localMaxVelocity = resolveShallowWaterVelocityLimitUnchecked(
        gravity,
        submergedDepth,
        absoluteMaxVelocity,
        options.maximumFroudeNumber,
      )
      const maximumDischarge = area * localMaxVelocity
      nextDischarge = Math.max(
        -maximumDischarge,
        Math.min(maximumDischarge, nextDischarge),
      )
    }
    if (!Number.isFinite(nextDischarge)) {
      throw new Error(`Hydraulic edge ${edge} produced a non-finite discharge.`)
    }
    scratch.candidateDischarge[edge] = nextDischarge
    if (nextDischarge > 0) scratch.outwardRate[from] += nextDischarge
    else scratch.outwardRate[to] -= nextDischarge
  }

  const sourceRate = prescribedRampInflow(
    solver.simulationTime + dt * 0.5,
    options.source,
  )
  const rawOutletRate = evaluateOutletDischarge(
    state.hydraulicHead[network.outletNode],
    options.outlet,
  )
  scratch.outwardRate[network.outletNode] += rawOutletRate

  for (let node = 0; node < network.nodeCount; node += 1) {
    const available =
      state.volume[node] + (node === network.sourceNode ? sourceRate * dt : 0)
    const requested = scratch.outwardRate[node] * dt
    if (requested > available * options.maxOutflowFraction && requested > 0) {
      scratch.limiter[node] =
        (available * options.maxOutflowFraction) / requested
    }
  }

  for (let edge = 0; edge < network.edgeCount; edge += 1) {
    const from = network.edgeFrom[edge]
    const to = network.edgeTo[edge]
    let discharge = scratch.candidateDischarge[edge]
    discharge *= discharge >= 0 ? scratch.limiter[from] : scratch.limiter[to]
    state.discharge[edge] = discharge
    const area = state.openingArea[edge]
    state.velocity[edge] = area > 1e-12 ? discharge / area : 0
    state.netInflow[from] -= discharge
    state.netInflow[to] += discharge
    const transportedVolume = discharge * dt
    state.cumulativeSignedVolume[edge] += transportedVolume
    state.cumulativeAbsoluteVolume[edge] += Math.abs(transportedVolume)
  }

  const outletRate = rawOutletRate * scratch.limiter[network.outletNode]
  state.netInflow[network.sourceNode] += sourceRate
  state.netInflow[network.outletNode] -= outletRate

  for (let node = 0; node < network.nodeCount; node += 1) {
    const nextVolume = state.volume[node] + state.netInflow[node] * dt
    if (!Number.isFinite(nextVolume)) {
      throw new Error(`Hydraulic node ${node} produced a non-finite volume.`)
    }
    if (nextVolume < -1e-11) {
      throw new Error(`Hydraulic node ${node} produced negative volume.`)
    }
    state.volume[node] = Math.max(0, nextVolume)
  }
  solver.cumulativeInjectedVolume += sourceRate * dt
  solver.cumulativeOutletVolume += outletRate * dt
  solver.outletDischarge = outletRate
  solver.simulationTime += dt
  updateNodeDerivedState(solver)
}

/** Advances one requested duration using stable substeps no larger than base dt. */
export function stepHydraulicSolver(
  solver: HydraulicSolver,
  durationSeconds = solver.options.physicsStepSeconds,
): HydraulicSolver {
  requirePositiveFinite('durationSeconds', durationSeconds)
  const count = Math.max(
    1,
    Math.ceil(durationSeconds / solver.options.physicsStepSeconds),
  )
  const dt = durationSeconds / count
  for (let index = 0; index < count; index += 1) {
    advanceOneSubstep(solver, dt)
  }
  return solver
}

/** Adds wall-clock budget and consumes it as identical fixed physics steps. */
export function advanceHydraulicSolver(
  solver: HydraulicSolver,
  durationSeconds: number,
): HydraulicSolver {
  requireNonNegativeFinite('durationSeconds', durationSeconds)
  solver.accumulatorSeconds += durationSeconds
  const dt = solver.options.physicsStepSeconds
  let steps = 0
  while (
    solver.accumulatorSeconds + Number.EPSILON >= dt &&
    steps < solver.options.maxSubstepsPerAdvance
  ) {
    advanceOneSubstep(solver, dt)
    solver.accumulatorSeconds -= dt
    steps += 1
  }
  if (solver.accumulatorSeconds < 1e-12) solver.accumulatorSeconds = 0
  return solver
}

export function resetHydraulicSolver(
  solver: HydraulicSolver,
  initialVolumes?: ArrayLike<number>,
): HydraulicSolver {
  writeInitialVolumes(solver, initialVolumes)
  solver.state.depth.fill(0)
  solver.state.hydraulicHead.fill(0)
  solver.state.netInflow.fill(0)
  solver.state.pressureProxy.fill(0)
  solver.state.discharge.fill(0)
  solver.state.velocity.fill(0)
  solver.state.openingArea.fill(0)
  solver.state.cumulativeSignedVolume.fill(0)
  solver.state.cumulativeAbsoluteVolume.fill(0)
  solver.simulationTime = 0
  solver.accumulatorSeconds = 0
  solver.initialStoredVolume = sum(solver.state.volume)
  solver.cumulativeInjectedVolume = 0
  solver.cumulativeOutletVolume = 0
  solver.outletDischarge = 0
  updateNodeDerivedState(solver)
  return solver
}

export function setHydraulicSource(
  solver: HydraulicSolver,
  source: boolean | Partial<PrescribedInflowBoundary>,
): void {
  if (typeof source === 'boolean') {
    solver.options.source.enabled = source
    return
  }
  Object.assign(solver.options.source, source)
  requireNonNegativeFinite(
    'targetFlowRateCubicMetersPerSecond',
    solver.options.source.targetFlowRateCubicMetersPerSecond,
  )
  requireNonNegativeFinite(
    'rampDurationSeconds',
    solver.options.source.rampDurationSeconds,
  )
}
