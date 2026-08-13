import { createHydraulicMessageProcessor } from './hydraulic.worker'
import {
  isHydraulicWorkerMessage,
  type HydraulicConfigureSourceCommand,
  type HydraulicErrorMessage,
  type HydraulicInitializePayload,
  type HydraulicReadyMessage,
  type HydraulicSnapshotMessage,
  type HydraulicWorkerCommand,
  type HydraulicWorkerMessage,
} from './protocol'

export type HydraulicBridgeMode = 'worker' | 'main-thread'

export interface HydraulicWorkerPort {
  postMessage(message: HydraulicWorkerCommand, transfer?: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<HydraulicWorkerMessage>) => void,
  ): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<HydraulicWorkerMessage>) => void,
  ): void
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  terminate(): void
}

export interface HydraulicBridgeOptions {
  sessionId?: string
  /** Injectable for deterministic tests and non-browser hosts. */
  workerFactory?: () => HydraulicWorkerPort
  forceMainThread?: boolean
  onSnapshot?: (snapshot: HydraulicSnapshotMessage) => void
  onError?: (error: HydraulicErrorMessage) => void
}

export interface HydraulicBridge {
  readonly sessionId: string
  readonly mode: HydraulicBridgeMode
  readonly generation: number
  readonly paused: boolean
  readonly ready: boolean
  initialize(payload: HydraulicInitializePayload): Promise<HydraulicReadyMessage>
  advance(realSeconds: number, speed?: number): void
  pause(): void
  resume(): void
  reset(initialVolumes?: Float64Array): void
  configureSource(
    source: HydraulicConfigureSourceCommand['source'],
  ): void
  getSnapshot(): HydraulicSnapshotMessage | null
  subscribe(
    listener: (snapshot: HydraulicSnapshotMessage) => void,
  ): () => void
  dispose(): void
}

let fallbackSessionCounter = 0

function createSessionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto)
  fallbackSessionCounter += 1
  return `hydraulic-${Date.now().toString(36)}-${fallbackSessionCounter.toString(36)}`
}

function createDefaultWorker(): HydraulicWorkerPort {
  return new Worker(new URL('./hydraulic.worker.ts', import.meta.url), {
    type: 'module',
    name: 'mazecraft-hydraulics',
  }) as HydraulicWorkerPort
}

class HydraulicBridgeImplementation implements HydraulicBridge {
  readonly sessionId: string

  private modeValue: HydraulicBridgeMode
  private worker: HydraulicWorkerPort | null
  private localProcessor: ReturnType<
    typeof createHydraulicMessageProcessor
  > | null
  private readonly snapshotListeners = new Set<
    (snapshot: HydraulicSnapshotMessage) => void
  >()
  private readonly errorListeners = new Set<
    (error: HydraulicErrorMessage) => void
  >()

  private generationValue = 0
  private commandSequence = 0
  private lastResponseSequence = -1
  private pausedValue = false
  private readyValue = false
  private disposed = false
  private latestSnapshot: HydraulicSnapshotMessage | null = null
  private initialization:
    | {
        generation: number
        resolve: (message: HydraulicReadyMessage) => void
        reject: (error: Error) => void
      }
    | null = null
  private pendingInitializeCommand:
    | Extract<HydraulicWorkerCommand, { type: 'initialize' }>
    | null = null
  private terminateTimer: ReturnType<typeof setTimeout> | null = null
  private readonly localCommandQueue: HydraulicWorkerCommand[] = []
  private readonly localMessageQueue: HydraulicWorkerMessage[] = []
  private localCommandFlushScheduled = false
  private localMessageFlushScheduled = false

  private readonly messageListener = (
    event: MessageEvent<HydraulicWorkerMessage>,
  ) => this.receive(event.data)

  private readonly workerErrorListener = (event: ErrorEvent) => {
    const message = event.message || 'Hydraulic Worker terminated unexpectedly.'
    if (this.fallbackFromWorkerStartup()) return
    this.reportTransportError(message)
    this.terminateWorker()
  }

  constructor(options: HydraulicBridgeOptions) {
    this.sessionId = options.sessionId ?? createSessionId()
    if (options.onSnapshot) this.snapshotListeners.add(options.onSnapshot)
    if (options.onError) this.errorListeners.add(options.onError)

    let worker: HydraulicWorkerPort | null = null
    if (
      !options.forceMainThread &&
      (options.workerFactory !== undefined || typeof Worker !== 'undefined')
    ) {
      try {
        worker = (options.workerFactory ?? createDefaultWorker)()
      } catch {
        worker = null
      }
    }

    this.worker = worker
    if (worker) {
      this.modeValue = 'worker'
      this.localProcessor = null
      worker.addEventListener('message', this.messageListener)
      worker.addEventListener('error', this.workerErrorListener)
    } else {
      this.modeValue = 'main-thread'
      this.localProcessor = this.createLocalProcessor()
    }
  }

  get mode(): HydraulicBridgeMode {
    return this.modeValue
  }

  get generation(): number {
    return this.generationValue
  }

  get paused(): boolean {
    return this.pausedValue
  }

  get ready(): boolean {
    return this.readyValue
  }

  initialize(payload: HydraulicInitializePayload): Promise<HydraulicReadyMessage> {
    this.assertUsable()
    if (this.initialization) {
      this.initialization.reject(
        new Error('Hydraulic initialization was superseded by a newer generation.'),
      )
      this.initialization = null
    }
    this.generationValue += 1
    this.pausedValue = false
    this.readyValue = false
    this.latestSnapshot = null
    this.lastResponseSequence = -1
    const generation = this.generationValue

    return new Promise((resolve, reject) => {
      this.initialization = { generation, resolve, reject }
      const command: Extract<HydraulicWorkerCommand, { type: 'initialize' }> = {
        type: 'initialize',
        sessionId: this.sessionId,
        generation,
        sequence: this.nextCommandSequence(),
        payload: {
          ...payload,
          solverOptions: payload.solverOptions
            ? {
                ...payload.solverOptions,
                initialVolumes: payload.solverOptions.initialVolumes
                  ? new Float64Array(payload.solverOptions.initialVolumes)
                  : undefined,
              }
            : undefined,
        },
      }
      this.pendingInitializeCommand = command
      this.send(command)
    })
  }

  advance(realSeconds: number, speed = 1): void {
    if (!this.canControl() || this.pausedValue) return
    this.send({
      type: 'advance',
      sessionId: this.sessionId,
      generation: this.generationValue,
      sequence: this.nextCommandSequence(),
      realSeconds,
      speed,
    })
  }

  pause(): void {
    if (!this.canControl() || this.pausedValue) return
    // Freeze locally before the command crosses the Worker boundary. A queued
    // pre-pause snapshot is therefore unable to move the renderer.
    this.pausedValue = true
    this.sendControl('pause')
  }

  resume(): void {
    if (!this.canControl() || !this.pausedValue) return
    this.sendControl('resume')
    this.pausedValue = false
  }

  reset(initialVolumes?: Float64Array): void {
    if (!this.canControl()) return
    this.generationValue += 1
    this.pausedValue = false
    this.latestSnapshot = null
    this.send({
      type: 'reset',
      sessionId: this.sessionId,
      generation: this.generationValue,
      sequence: this.nextCommandSequence(),
      initialVolumes: initialVolumes
        ? new Float64Array(initialVolumes)
        : undefined,
    })
  }

  configureSource(source: HydraulicConfigureSourceCommand['source']): void {
    if (!this.canControl()) return
    this.send({
      type: 'configure-source',
      sessionId: this.sessionId,
      generation: this.generationValue,
      sequence: this.nextCommandSequence(),
      source,
    })
  }

  getSnapshot(): HydraulicSnapshotMessage | null {
    return this.latestSnapshot
  }

  subscribe(
    listener: (snapshot: HydraulicSnapshotMessage) => void,
  ): () => void {
    this.assertUsable()
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    const wasReady = this.readyValue
    this.disposed = true
    this.readyValue = false
    this.pausedValue = true
    this.initialization?.reject(new Error('Hydraulic bridge was disposed.'))
    this.initialization = null
    this.pendingInitializeCommand = null
    this.localCommandQueue.length = 0
    this.localMessageQueue.length = 0

    if (wasReady) {
      this.sendUnchecked({
        type: 'dispose',
        sessionId: this.sessionId,
        generation: this.generationValue,
        sequence: this.nextCommandSequence(),
      })
    }

    if (this.worker) {
      // Give the worker one task to acknowledge disposal, then guarantee the
      // thread is reclaimed even if it is unhealthy.
      this.terminateTimer = setTimeout(() => this.terminateWorker(), 100)
    }
    this.snapshotListeners.clear()
    this.errorListeners.clear()
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Hydraulic bridge has been disposed.')
  }

  private canControl(): boolean {
    return !this.disposed && this.readyValue && this.generationValue > 0
  }

  private nextCommandSequence(): number {
    this.commandSequence += 1
    return this.commandSequence
  }

  private sendControl(type: 'pause' | 'resume'): void {
    this.send({
      type,
      sessionId: this.sessionId,
      generation: this.generationValue,
      sequence: this.nextCommandSequence(),
    })
  }

  private send(command: HydraulicWorkerCommand): void {
    this.assertUsable()
    this.sendUnchecked(command)
  }

  private sendUnchecked(command: HydraulicWorkerCommand): void {
    if (this.worker) this.worker.postMessage(command)
    else this.enqueueLocalCommand(command)
  }

  private createLocalProcessor(): ReturnType<
    typeof createHydraulicMessageProcessor
  > {
    return createHydraulicMessageProcessor((message) => {
      // Match a Worker task boundary. In particular, renderer callbacks can
      // never re-enter the solver while it is advancing.
      this.enqueueLocalMessage(message)
    })
  }

  /**
   * A Worker constructor can succeed even when its module subsequently fails
   * to load. Before `ready`, no solver state is authoritative, so replaying the
   * same initialize command through the shared processor is lossless.
   */
  private fallbackFromWorkerStartup(): boolean {
    if (
      this.disposed ||
      this.readyValue ||
      !this.worker
    ) return false

    const command = this.pendingInitializeCommand
    this.terminateWorker()
    this.modeValue = 'main-thread'
    this.localProcessor = this.createLocalProcessor()
    // The replacement processor starts a fresh response sequence for the same
    // generation; no messages can arrive from the terminated worker now.
    this.lastResponseSequence = -1
    if (
      command &&
      this.initialization?.generation === command.generation &&
      command.generation === this.generationValue
    ) this.enqueueLocalCommand(command)
    return true
  }

  private enqueueLocalCommand(command: HydraulicWorkerCommand): void {
    this.localCommandQueue.push(command)
    if (this.localCommandFlushScheduled) return
    this.localCommandFlushScheduled = true
    queueMicrotask(() => {
      this.localCommandFlushScheduled = false
      const commands = this.localCommandQueue.splice(0)
      for (const queued of commands) this.localProcessor?.handle(queued)
    })
  }

  private enqueueLocalMessage(message: HydraulicWorkerMessage): void {
    this.localMessageQueue.push(message)
    if (this.localMessageFlushScheduled) return
    this.localMessageFlushScheduled = true
    queueMicrotask(() => {
      this.localMessageFlushScheduled = false
      const messages = this.localMessageQueue.splice(0)
      for (const queued of messages) this.receive(queued)
    })
  }

  private receive(message: unknown): void {
    if (!isHydraulicWorkerMessage(message)) return
    if (message.sessionId !== this.sessionId) return
    if (this.disposed) {
      if (message.type === 'disposed') this.terminateWorker()
      return
    }
    if (message.generation !== this.generationValue) return
    if (message.sequence <= this.lastResponseSequence) return
    this.lastResponseSequence = message.sequence

    if (message.type === 'ready') {
      this.readyValue = true
      this.pendingInitializeCommand = null
      if (this.initialization?.generation === message.generation) {
        const { resolve } = this.initialization
        this.initialization = null
        resolve(message)
      }
      return
    }

    if (message.type === 'snapshot') {
      if (this.pausedValue || !this.readyValue || this.disposed) return
      this.latestSnapshot = message
      for (const listener of this.snapshotListeners) {
        try {
          listener(message)
        } catch (error) {
          console.error('Hydraulic snapshot listener failed.', error)
        }
      }
      return
    }

    if (message.type === 'error') {
      if (message.fatal) {
        this.readyValue = false
        this.pendingInitializeCommand = null
        if (this.initialization?.generation === message.generation) {
          const { reject } = this.initialization
          this.initialization = null
          reject(new Error(message.message))
        }
      }
      for (const listener of this.errorListeners) {
        try {
          listener(message)
        } catch (error) {
          console.error('Hydraulic error listener failed.', error)
        }
      }
      return
    }

    if (message.type === 'disposed') this.terminateWorker()
  }

  private reportTransportError(message: string): void {
    const error: HydraulicErrorMessage = {
      type: 'error',
      sessionId: this.sessionId,
      generation: this.generationValue,
      sequence: this.lastResponseSequence + 1,
      message,
      fatal: true,
    }
    this.receive(error)
  }

  private terminateWorker(): void {
    if (!this.worker) return
    const worker = this.worker
    this.worker = null
    if (this.terminateTimer) {
      clearTimeout(this.terminateTimer)
      this.terminateTimer = null
    }
    worker.removeEventListener('message', this.messageListener)
    worker.removeEventListener('error', this.workerErrorListener)
    worker.terminate()
  }
}

export function createHydraulicBridge(
  options: HydraulicBridgeOptions = {},
): HydraulicBridge {
  return new HydraulicBridgeImplementation(options)
}
