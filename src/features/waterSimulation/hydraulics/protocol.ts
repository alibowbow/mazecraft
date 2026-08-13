import type { CellPosition, MazeGraph } from '../../../core/maze'
import type { PrescribedInflowBoundary, OutletBoundary } from './boundaries'
import type { HydraulicNetworkOptions } from './network'
import type { HydraulicSolverOptions } from './solver'

/**
 * Messages are scoped twice: `sessionId` separates bridge instances and
 * `generation` separates resets/re-initialisations inside one instance.
 * `sequence` is monotonic for the lifetime of a bridge and makes delayed or
 * duplicated messages harmless.
 */
export interface HydraulicProtocolEnvelope {
  sessionId: string
  generation: number
  sequence: number
}

export interface HydraulicSolverConfiguration
  extends Omit<HydraulicSolverOptions, 'initialVolumes' | 'source' | 'outlet'> {
  source?: Partial<PrescribedInflowBoundary>
  outlet?: Partial<OutletBoundary>
  /** Typed for efficient structured cloning and deterministic node ordering. */
  initialVolumes?: Float64Array
}

export interface HydraulicInitializePayload {
  graph: MazeGraph
  source: CellPosition
  outlet: CellPosition
  networkOptions?: HydraulicNetworkOptions
  solverOptions?: HydraulicSolverConfiguration
  /** Renderer delivery cadence. Physics cadence is independent. */
  snapshotHz?: number
}

export interface HydraulicInitializeCommand extends HydraulicProtocolEnvelope {
  type: 'initialize'
  payload: HydraulicInitializePayload
}

export interface HydraulicAdvanceCommand extends HydraulicProtocolEnvelope {
  type: 'advance'
  /** Wall-clock budget to simulate before applying `speed`. */
  realSeconds: number
  /** Multiplies the number of fixed steps, never the fixed step size. */
  speed: number
}

export interface HydraulicPauseCommand extends HydraulicProtocolEnvelope {
  type: 'pause'
}

export interface HydraulicResumeCommand extends HydraulicProtocolEnvelope {
  type: 'resume'
}

export interface HydraulicResetCommand extends HydraulicProtocolEnvelope {
  type: 'reset'
  initialVolumes?: Float64Array
}

export interface HydraulicConfigureSourceCommand
  extends HydraulicProtocolEnvelope {
  type: 'configure-source'
  source: boolean | Partial<PrescribedInflowBoundary>
}

export interface HydraulicDisposeCommand extends HydraulicProtocolEnvelope {
  type: 'dispose'
}

export type HydraulicWorkerCommand =
  | HydraulicInitializeCommand
  | HydraulicAdvanceCommand
  | HydraulicPauseCommand
  | HydraulicResumeCommand
  | HydraulicResetCommand
  | HydraulicConfigureSourceCommand
  | HydraulicDisposeCommand

export interface HydraulicDiagnosticsSnapshot {
  simulationTime: number
  cumulativeInjectedVolume: number
  cumulativeOutletVolume: number
  currentStoredVolume: number
  absoluteMassError: number
  relativeMassError: number
  maxVelocity: number
  activeFlowEdgeCount: number
  outletDischarge: number
}

export interface HydraulicReadyMessage extends HydraulicProtocolEnvelope {
  type: 'ready'
  nodeCount: number
  edgeCount: number
  physicsStepHz: number
  snapshotHz: number
}

export interface HydraulicSnapshotMessage extends HydraulicProtocolEnvelope {
  type: 'snapshot'
  depth: Float64Array
  edgeDischarge: Float64Array
  edgeVelocity: Float64Array
  diagnostics: HydraulicDiagnosticsSnapshot
}

export interface HydraulicErrorMessage extends HydraulicProtocolEnvelope {
  type: 'error'
  message: string
  commandType?: HydraulicWorkerCommand['type']
  fatal: boolean
}

export interface HydraulicDisposedMessage extends HydraulicProtocolEnvelope {
  type: 'disposed'
}

export type HydraulicWorkerMessage =
  | HydraulicReadyMessage
  | HydraulicSnapshotMessage
  | HydraulicErrorMessage
  | HydraulicDisposedMessage

export const HYDRAULIC_DEFAULT_PHYSICS_STEP_SECONDS = 1 / 120
export const HYDRAULIC_DEFAULT_SNAPSHOT_HZ = 25
export const HYDRAULIC_MIN_SNAPSHOT_HZ = 20
export const HYDRAULIC_MAX_SNAPSHOT_HZ = 30

export function resolveHydraulicSnapshotHz(value?: number): number {
  if (value === undefined) return HYDRAULIC_DEFAULT_SNAPSHOT_HZ
  if (!Number.isFinite(value)) {
    throw new RangeError('snapshotHz must be finite.')
  }
  return Math.min(
    HYDRAULIC_MAX_SNAPSHOT_HZ,
    Math.max(HYDRAULIC_MIN_SNAPSHOT_HZ, value),
  )
}

export function hydraulicSnapshotTransferables(
  message: HydraulicSnapshotMessage,
): Transferable[] {
  return [
    message.depth.buffer,
    message.edgeDischarge.buffer,
    message.edgeVelocity.buffer,
  ]
}

export function isHydraulicWorkerMessage(
  value: unknown,
): value is HydraulicWorkerMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HydraulicWorkerMessage>
  return (
    typeof candidate.sessionId === 'string' &&
    Number.isSafeInteger(candidate.generation) &&
    Number.isSafeInteger(candidate.sequence) &&
    (candidate.type === 'ready' ||
      candidate.type === 'snapshot' ||
      candidate.type === 'error' ||
      candidate.type === 'disposed')
  )
}
