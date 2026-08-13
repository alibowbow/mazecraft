import { describe, expect, it, vi } from 'vitest'
import { createEmptyGraph, openPassage } from '../../../core/maze'
import { createHydraulicBridge, type HydraulicWorkerPort } from './bridge'
import { createHydraulicMessageProcessor } from './hydraulic.worker'
import {
  resolveHydraulicSnapshotHz,
  type HydraulicInitializeCommand,
  type HydraulicSnapshotMessage,
  type HydraulicWorkerCommand,
  type HydraulicWorkerMessage,
} from './protocol'

class FakeWorker implements HydraulicWorkerPort {
  readonly commands: HydraulicWorkerCommand[] = []
  readonly messageListeners = new Set<
    (event: MessageEvent<HydraulicWorkerMessage>) => void
  >()
  readonly errorListeners = new Set<(event: ErrorEvent) => void>()
  terminated = false

  postMessage(message: HydraulicWorkerCommand): void {
    this.commands.push(message)
  }

  addEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: MessageEvent<HydraulicWorkerMessage>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.add(
        listener as (event: MessageEvent<HydraulicWorkerMessage>) => void,
      )
    } else {
      this.errorListeners.add(listener as (event: ErrorEvent) => void)
    }
  }

  removeEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: MessageEvent<HydraulicWorkerMessage>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(
        listener as (event: MessageEvent<HydraulicWorkerMessage>) => void,
      )
    } else {
      this.errorListeners.delete(listener as (event: ErrorEvent) => void)
    }
  }

  terminate(): void {
    this.terminated = true
  }

  emit(message: HydraulicWorkerMessage): void {
    for (const listener of this.messageListeners) {
      listener(new MessageEvent('message', { data: message }))
    }
  }

  fail(message = 'Worker module failed to load'): void {
    for (const listener of this.errorListeners) {
      listener(new ErrorEvent('error', { message }))
    }
  }
}

const payload = () => ({
  graph: createEmptyGraph(1, 1),
  source: { row: 0, col: 0 },
  outlet: { row: 0, col: 0 },
})

function initializedBridge() {
  const worker = new FakeWorker()
  const onSnapshot = vi.fn()
  const bridge = createHydraulicBridge({
    sessionId: 'session-a',
    workerFactory: () => worker,
    onSnapshot,
  })
  const readyPromise = bridge.initialize(payload())
  const initialize = worker.commands[0] as HydraulicInitializeCommand
  worker.emit({
    type: 'ready',
    sessionId: initialize.sessionId,
    generation: initialize.generation,
    sequence: 1,
    nodeCount: 1,
    edgeCount: 0,
    physicsStepHz: 120,
    snapshotHz: 25,
  })
  return { bridge, worker, onSnapshot, readyPromise, initialize }
}

function snapshot(
  generation: number,
  sequence: number,
): HydraulicSnapshotMessage {
  return {
    type: 'snapshot',
    sessionId: 'session-a',
    generation,
    sequence,
    depth: new Float64Array([sequence]),
    edgeDischarge: new Float64Array(0),
    edgeVelocity: new Float64Array(0),
    diagnostics: {
      simulationTime: sequence / 25,
      cumulativeInjectedVolume: 0,
      cumulativeOutletVolume: 0,
      currentStoredVolume: 0,
      absoluteMassError: 0,
      relativeMassError: 0,
      maxVelocity: 0,
      activeFlowEdgeCount: 0,
      outletDischarge: 0,
    },
  }
}

describe('hydraulic bridge protocol', () => {
  it('runs the same fixed-step solver in the main-thread fallback', async () => {
    const graph = createEmptyGraph(2, 1)
    expect(
      openPassage(graph, { row: 0, col: 0 }, { row: 1, col: 0 }),
    ).toBe(true)
    const snapshots: HydraulicSnapshotMessage[] = []
    const bridge = createHydraulicBridge({
      sessionId: 'fallback-session',
      forceMainThread: true,
      onSnapshot: (message) => snapshots.push(message),
    })

    const readyPromise = bridge.initialize({
      graph,
      source: { row: 0, col: 0 },
      outlet: { row: 1, col: 0 },
      snapshotHz: 20,
      solverOptions: {
        source: {
          targetFlowRateCubicMetersPerSecond: 0.01,
          rampDurationSeconds: 0,
        },
      },
    })
    expect(bridge.ready).toBe(false)
    const ready = await readyPromise
    expect(bridge.mode).toBe('main-thread')
    expect(ready).toMatchObject({ nodeCount: 2, edgeCount: 1 })
    expect(snapshots).toHaveLength(1)

    bridge.advance(0.05, 4)
    await Promise.resolve()
    await Promise.resolve()
    const advanced = bridge.getSnapshot()!
    expect(advanced.depth).toHaveLength(2)
    expect(advanced.edgeDischarge).toHaveLength(1)
    expect(advanced.edgeVelocity).toHaveLength(1)
    expect(advanced.diagnostics.simulationTime).toBeCloseTo(0.2, 8)
    expect(advanced.diagnostics.currentStoredVolume).toBeGreaterThan(0)

    bridge.pause()
    bridge.advance(1, 4)
    expect(bridge.getSnapshot()).toBe(advanced)

    bridge.reset()
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.getSnapshot()?.diagnostics.simulationTime).toBe(0)
    expect(bridge.getSnapshot()?.diagnostics.currentStoredVolume).toBe(0)
    bridge.advance(0.05, 1)
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.getSnapshot()?.diagnostics.simulationTime).toBeCloseTo(0.05)
    bridge.dispose()
  })

  it('tags a failed re-initialization with the candidate generation', () => {
    const messages: HydraulicWorkerMessage[] = []
    const processor = createHydraulicMessageProcessor((message) => {
      messages.push(message)
    })
    const valid: HydraulicInitializeCommand = {
      type: 'initialize',
      sessionId: 'reinitialize-session',
      generation: 1,
      sequence: 1,
      payload: payload(),
    }
    processor.handle(valid)
    processor.handle({
      ...valid,
      generation: 2,
      sequence: 2,
      payload: {
        ...payload(),
        source: { row: 5, col: 5 },
      },
    })

    expect(messages.at(-1)).toMatchObject({
      type: 'error',
      sessionId: valid.sessionId,
      generation: 2,
      commandType: 'initialize',
      fatal: true,
    })
  })

  it('rejects a failed fallback re-initialization instead of hanging', async () => {
    const bridge = createHydraulicBridge({
      sessionId: 'fallback-reinitialize',
      forceMainThread: true,
    })
    await bridge.initialize(payload())

    await expect(
      bridge.initialize({
        ...payload(),
        source: { row: 5, col: 5 },
      }),
    ).rejects.toThrow('source must be an active maze cell')
    expect(bridge.ready).toBe(false)
  })

  it('keeps fallback delivery out of solver execution and isolates listener errors', async () => {
    const listenerError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    let bridge!: ReturnType<typeof createHydraulicBridge>
    let callbackInsideAdvance = false
    let advancing = false
    let observeCallback = false
    let callbackCount = 0
    const hydraulicErrors = vi.fn()
    bridge = createHydraulicBridge({
      sessionId: 'fallback-reentrancy',
      forceMainThread: true,
      onError: hydraulicErrors,
      onSnapshot: () => {
        if (!observeCallback) return
        callbackInsideAdvance ||= advancing
        if (callbackCount++ === 0) bridge.reset()
        throw new Error('renderer callback failure')
      },
    })
    await bridge.initialize(payload())
    observeCallback = true
    listenerError.mockClear()

    advancing = true
    bridge.advance(0.05)
    advancing = false
    expect(callbackInsideAdvance).toBe(false)
    await Promise.resolve()
    await Promise.resolve()

    expect(callbackInsideAdvance).toBe(false)
    expect(hydraulicErrors).not.toHaveBeenCalled()
    expect(listenerError).toHaveBeenCalledWith(
      'Hydraulic snapshot listener failed.',
      expect.any(Error),
    )
    listenerError.mockRestore()
    bridge.dispose()
  })

  it('prefers the worker, resolves ready, and sends speed as a budget multiplier', async () => {
    const { bridge, worker, readyPromise } = initializedBridge()
    expect(bridge.mode).toBe('worker')
    await expect(readyPromise).resolves.toMatchObject({ physicsStepHz: 120 })

    bridge.advance(1 / 60, 4)
    expect(worker.commands.at(-1)).toMatchObject({
      type: 'advance',
      realSeconds: 1 / 60,
      speed: 4,
    })
  })

  it('falls back after an asynchronous Worker startup failure without replacing the initialize Promise', async () => {
    const worker = new FakeWorker()
    const onError = vi.fn()
    const bridge = createHydraulicBridge({
      sessionId: 'async-worker-fallback',
      workerFactory: () => worker,
      onError,
    })
    const readyPromise = bridge.initialize(payload())
    const initialize = worker.commands[0] as HydraulicInitializeCommand

    expect(bridge.mode).toBe('worker')
    expect(initialize).toMatchObject({ generation: 1, sequence: 1 })
    worker.fail()

    expect(worker.terminated).toBe(true)
    expect(bridge.mode).toBe('main-thread')
    expect(bridge.ready).toBe(false)
    await expect(readyPromise).resolves.toMatchObject({
      generation: initialize.generation,
      nodeCount: 1,
    })
    expect(bridge.mode).toBe('main-thread')
    expect(bridge.generation).toBe(initialize.generation)
    expect(bridge.getSnapshot()?.generation).toBe(initialize.generation)
    expect(onError).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('switches to fallback when the Worker fails before initialize is called', async () => {
    const worker = new FakeWorker()
    const bridge = createHydraulicBridge({
      sessionId: 'worker-failed-before-initialize',
      workerFactory: () => worker,
    })

    worker.fail()
    expect(worker.terminated).toBe(true)
    expect(bridge.mode).toBe('main-thread')
    await expect(bridge.initialize(payload())).resolves.toMatchObject({
      nodeCount: 1,
    })
    bridge.dispose()
  })

  it('keeps a post-ready Worker failure fatal instead of rebuilding unknown state', async () => {
    const worker = new FakeWorker()
    const onError = vi.fn()
    const bridge = createHydraulicBridge({
      sessionId: 'runtime-worker-failure',
      workerFactory: () => worker,
      onError,
    })
    const readyPromise = bridge.initialize(payload())
    const initialize = worker.commands[0] as HydraulicInitializeCommand
    worker.emit({
      type: 'ready',
      sessionId: initialize.sessionId,
      generation: initialize.generation,
      sequence: 1,
      nodeCount: 1,
      edgeCount: 0,
      physicsStepHz: 120,
      snapshotHz: 25,
    })
    await readyPromise

    worker.fail('runtime crash')
    expect(worker.terminated).toBe(true)
    expect(bridge.mode).toBe('worker')
    expect(bridge.ready).toBe(false)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'runtime crash',
        fatal: true,
      }),
    )
    bridge.dispose()
  })

  it('freezes locally on pause and rejects queued snapshots', () => {
    const { bridge, worker, onSnapshot, initialize } = initializedBridge()
    worker.emit(snapshot(initialize.generation, 2))
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    bridge.pause()
    worker.emit(snapshot(initialize.generation, 3))
    bridge.advance(1, 1)
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(worker.commands.at(-1)?.type).toBe('pause')

    bridge.resume()
    bridge.advance(0.04, 1)
    expect(worker.commands.slice(-2).map((command) => command.type)).toEqual([
      'resume',
      'advance',
    ])
  })

  it('increments generation on reset and ignores stale or duplicate responses', () => {
    const { bridge, worker, onSnapshot, initialize } = initializedBridge()
    worker.emit(snapshot(initialize.generation, 2))

    bridge.reset()
    const reset = worker.commands.at(-1)!
    expect(reset).toMatchObject({
      type: 'reset',
      generation: initialize.generation + 1,
    })
    worker.emit(snapshot(initialize.generation, 99))
    worker.emit(snapshot(reset.generation, 3))
    worker.emit(snapshot(reset.generation, 3))

    expect(onSnapshot).toHaveBeenCalledTimes(2)
    expect(bridge.getSnapshot()?.generation).toBe(reset.generation)
  })

  it('rejects foreign sessions and terminates after disposal acknowledgement', () => {
    const { bridge, worker, onSnapshot, initialize } = initializedBridge()
    worker.emit({
      ...snapshot(initialize.generation, 2),
      sessionId: 'foreign-session',
    })
    expect(onSnapshot).not.toHaveBeenCalled()

    bridge.dispose()
    const dispose = worker.commands.at(-1)!
    expect(dispose.type).toBe('dispose')
    worker.emit({
      type: 'disposed',
      sessionId: 'session-a',
      generation: dispose.generation,
      sequence: 2,
    })
    expect(worker.terminated).toBe(true)
  })

  it('bounds renderer snapshots to the documented 20-30Hz range', () => {
    expect(resolveHydraulicSnapshotHz()).toBe(25)
    expect(resolveHydraulicSnapshotHz(1)).toBe(20)
    expect(resolveHydraulicSnapshotHz(120)).toBe(30)
    expect(() => resolveHydraulicSnapshotHz(Number.NaN)).toThrow()
  })
})
