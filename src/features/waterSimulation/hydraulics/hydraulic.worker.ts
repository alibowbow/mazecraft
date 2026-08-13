/// <reference lib="webworker" />

import {
  advanceHydraulicSolver,
  createHydraulicSolver,
  resetHydraulicSolver,
  setHydraulicSource,
} from './solver'
import { getHydraulicDiagnostics } from './diagnostics'
import { buildHydraulicNetwork, type HydraulicNetwork } from './network'
import {
  HYDRAULIC_DEFAULT_PHYSICS_STEP_SECONDS,
  hydraulicSnapshotTransferables,
  resolveHydraulicSnapshotHz,
  type HydraulicDiagnosticsSnapshot,
  type HydraulicSnapshotMessage,
  type HydraulicWorkerCommand,
  type HydraulicWorkerMessage,
} from './protocol'

type HydraulicSolverInstance = ReturnType<typeof createHydraulicSolver>

export type HydraulicWorkerEmitter = (
  message: HydraulicWorkerMessage,
  transfer?: Transferable[],
) => void

interface ActiveSession {
  sessionId: string
  generation: number
  lastCommandSequence: number
  responseSequence: number
  network: HydraulicNetwork
  solver: HydraulicSolverInstance
  physicsStepSeconds: number
  snapshotHz: number
  snapshotAccumulatorSeconds: number
  paused: boolean
}

interface SolverStateView {
  depth: Float64Array
  discharge: Float64Array
  velocity: Float64Array
}

function readFiniteDiagnostic(
  raw: Record<string, unknown>,
  ...names: string[]
): number {
  for (const name of names) {
    if (raw[name] === undefined) continue
    const value = raw[name]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Hydraulic diagnostic ${name} is not finite.`)
    }
    return value
  }
  throw new Error(`Hydraulic diagnostic ${names[0]} is missing.`)
}

function copyFiniteArray(name: string, source: Float64Array): Float64Array {
  const copy = new Float64Array(source.length)
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index]
    if (!Number.isFinite(value)) {
      throw new Error(`${name}[${index}] is not finite.`)
    }
    copy[index] = value
  }
  return copy
}

function diagnosticsSnapshot(
  solver: HydraulicSolverInstance,
): HydraulicDiagnosticsSnapshot {
  const raw = getHydraulicDiagnostics(solver) as unknown as Record<string, unknown>
  return {
    simulationTime: readFiniteDiagnostic(
      raw,
      'simulationTime',
      'simulationTimeSeconds',
    ),
    cumulativeInjectedVolume: readFiniteDiagnostic(
      raw,
      'cumulativeInjectedVolume',
      'injectedVolume',
    ),
    cumulativeOutletVolume: readFiniteDiagnostic(
      raw,
      'cumulativeOutletVolume',
      'outletVolume',
    ),
    currentStoredVolume: readFiniteDiagnostic(
      raw,
      'currentStoredVolume',
      'storedVolume',
    ),
    absoluteMassError: readFiniteDiagnostic(
      raw,
      'absoluteMassError',
      'massAbsoluteError',
    ),
    relativeMassError: readFiniteDiagnostic(
      raw,
      'relativeMassError',
      'massRelativeError',
    ),
    maxVelocity: readFiniteDiagnostic(raw, 'maxVelocity'),
    activeFlowEdgeCount: readFiniteDiagnostic(raw, 'activeFlowEdgeCount'),
    outletDischarge: readFiniteDiagnostic(raw, 'outletDischarge'),
  }
}

function readSolverState(solver: HydraulicSolverInstance): SolverStateView {
  const state = (solver as unknown as { state: SolverStateView }).state
  if (
    !state ||
    !(state.depth instanceof Float64Array) ||
    !(state.discharge instanceof Float64Array) ||
    !(state.velocity instanceof Float64Array)
  ) {
    throw new TypeError('Hydraulic solver exposed an invalid typed-array state.')
  }
  return state
}

/**
 * Shared command processor. The browser Worker and the main-thread fallback
 * both execute this exact implementation, so fallback changes scheduling only
 * and never changes the hydraulic equations.
 */
export function createHydraulicMessageProcessor(emit: HydraulicWorkerEmitter) {
  let active: ActiveSession | null = null
  let disposed = false

  const responseEnvelope = () => {
    if (!active) throw new Error('Hydraulic session is not initialized.')
    active.responseSequence += 1
    return {
      sessionId: active.sessionId,
      generation: active.generation,
      sequence: active.responseSequence,
    }
  }

  const emitSnapshot = (): void => {
    if (!active) return
    const state = readSolverState(active.solver)
    const message: HydraulicSnapshotMessage = {
      type: 'snapshot',
      ...responseEnvelope(),
      // Copies own their buffers. Transferring them can never detach solver state.
      depth: copyFiniteArray('depth', state.depth),
      edgeDischarge: copyFiniteArray('discharge', state.discharge),
      edgeVelocity: copyFiniteArray('velocity', state.velocity),
      diagnostics: diagnosticsSnapshot(active.solver),
    }
    emit(message, hydraulicSnapshotTransferables(message))
  }

  const emitError = (
    command: HydraulicWorkerCommand,
    error: unknown,
    fatal: boolean,
  ): void => {
    const sequence = active && active.sessionId === command.sessionId
      ? ++active.responseSequence
      : 0
    emit({
      type: 'error',
      sessionId: command.sessionId,
      // Initialization can fail before the candidate generation becomes
      // active. Report the command generation so its Promise can settle.
      generation: command.generation,
      sequence,
      commandType: command.type,
      message: error instanceof Error ? error.message : String(error),
      fatal,
    })
  }

  const initialize = (
    command: Extract<HydraulicWorkerCommand, { type: 'initialize' }>,
  ): void => {
    const { payload } = command
    const responseSequence =
      active?.sessionId === command.sessionId ? active.responseSequence : 0
    const network = buildHydraulicNetwork(
      payload.graph,
      payload.source,
      payload.outlet,
      payload.networkOptions,
    )
    const solver = createHydraulicSolver(
      network,
      payload.solverOptions as Parameters<typeof createHydraulicSolver>[1],
    )
    const physicsStepSeconds =
      payload.solverOptions?.physicsStepSeconds ??
      HYDRAULIC_DEFAULT_PHYSICS_STEP_SECONDS
    if (!Number.isFinite(physicsStepSeconds) || physicsStepSeconds <= 0) {
      throw new RangeError('physicsStepSeconds must be positive and finite.')
    }
    active = {
      sessionId: command.sessionId,
      generation: command.generation,
      lastCommandSequence: command.sequence,
      responseSequence,
      network,
      solver,
      physicsStepSeconds,
      snapshotHz: resolveHydraulicSnapshotHz(payload.snapshotHz),
      snapshotAccumulatorSeconds: 0,
      paused: false,
    }
    disposed = false
    emit({
      type: 'ready',
      ...responseEnvelope(),
      nodeCount: network.nodeCount,
      edgeCount: network.edgeCount,
      physicsStepHz: 1 / physicsStepSeconds,
      snapshotHz: active.snapshotHz,
    })
    emitSnapshot()
  }

  const handle = (command: HydraulicWorkerCommand): void => {
    if (command.type === 'initialize') {
      if (
        active &&
        command.sessionId === active.sessionId &&
        (command.generation < active.generation ||
          command.sequence <= active.lastCommandSequence)
      ) return
      try {
        initialize(command)
      } catch (error) {
        emitError(command, error, true)
      }
      return
    }

    if (disposed || !active) return
    if (command.sessionId !== active.sessionId) return
    if (command.type === 'reset') {
      if (command.generation <= active.generation) return
    } else if (command.generation !== active.generation) {
      return
    }
    if (command.sequence <= active.lastCommandSequence) return
    active.lastCommandSequence = command.sequence

    try {
      switch (command.type) {
        case 'advance': {
          if (active.paused) return
          if (
            !Number.isFinite(command.realSeconds) ||
            command.realSeconds < 0 ||
            !Number.isFinite(command.speed) ||
            command.speed <= 0
          ) {
            throw new RangeError('Advance budget and speed must be finite and positive.')
          }
          // Speed changes the amount of simulated time, while the solver keeps
          // its own fixed substep unchanged.
          advanceHydraulicSolver(active.solver, command.realSeconds * command.speed)
          active.snapshotAccumulatorSeconds += command.realSeconds
          if (active.snapshotAccumulatorSeconds + Number.EPSILON >= 1 / active.snapshotHz) {
            active.snapshotAccumulatorSeconds %= 1 / active.snapshotHz
            emitSnapshot()
          }
          break
        }
        case 'pause':
          active.paused = true
          break
        case 'resume':
          active.paused = false
          active.snapshotAccumulatorSeconds = 0
          break
        case 'reset':
          active.generation = command.generation
          // Reset is a new playable generation. A pause command from the old
          // generation must not leave the worker silently frozen.
          active.paused = false
          active.snapshotAccumulatorSeconds = 0
          resetHydraulicSolver(active.solver, command.initialVolumes)
          emitSnapshot()
          break
        case 'configure-source':
          setHydraulicSource(active.solver, command.source)
          break
        case 'dispose': {
          const message: HydraulicWorkerMessage = {
            type: 'disposed',
            ...responseEnvelope(),
          }
          emit(message)
          active = null
          disposed = true
          break
        }
      }
    } catch (error) {
      emitError(command, error, false)
    }
  }

  return {
    handle,
    get activeSession(): Readonly<ActiveSession> | null {
      return active
    },
  }
}

function isDedicatedWorkerScope(
  value: typeof globalThis,
): value is typeof globalThis & DedicatedWorkerGlobalScope {
  return (
    typeof (value as { document?: unknown }).document === 'undefined' &&
    typeof (value as { postMessage?: unknown }).postMessage === 'function' &&
    typeof (value as { addEventListener?: unknown }).addEventListener === 'function'
  )
}

if (isDedicatedWorkerScope(globalThis)) {
  const processor = createHydraulicMessageProcessor((message, transfer = []) => {
    globalThis.postMessage(message, transfer)
  })
  globalThis.addEventListener(
    'message',
    (event: MessageEvent<HydraulicWorkerCommand>) => processor.handle(event.data),
  )
}
