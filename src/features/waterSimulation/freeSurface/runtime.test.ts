import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultProject } from '../../../core/maze'
import type { FluidSnapshot, FluidSnapshotBuffers } from './types'
import { FreeSurfaceRuntime } from './runtime'

const rendering = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), setViewMode: vi.fn() }))
vi.mock('./renderer', () => ({
  FreeSurfaceRenderer: class {
    canvas = { width: 640, height: 480 }
    render = rendering.render
    dispose = rendering.dispose
    setViewMode = rendering.setViewMode
    setSurfaceStyle() {}
    setInflow() {}
    resetCamera() {}
  },
}))

type Command = { type: string; generation: number; steps?: number; inflow?: number; publish?: boolean; buffers?: FluidSnapshotBuffers }
class FakeWorker {
  static current: FakeWorker
  readonly commands: Command[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  terminated = false
  pending = false
  time = 0
  snapshots = 0
  arraysAllocated = 0
  private buffers: FluidSnapshotBuffers[] = []
  constructor() { FakeWorker.current = this }
  postMessage(command: Command, options?: StructuredSerializeOptions) {
    if (command.type === 'advance') expect(this.pending).toBe(false)
    this.pending = true
    const received = structuredClone(command, options)
    if (received.buffers) this.buffers.push(received.buffers)
    this.commands.push(received)
  }
  terminate() { this.terminated = true }
  complete(generation = this.commands.at(-1)!.generation) {
    const command = this.commands.at(-1)!
    if (generation === command.generation) {
      this.pending = false
      if (command.type === 'advance') this.time += command.steps! / 120
      else this.time = 0
    }
    if (command.type === 'advance' && command.publish === false) {
      this.onmessage?.({ data: { type: 'advanced', generation } })
      return
    }
    this.snapshots++
    let buffers = this.buffers.pop()
    if (!buffers) {
      this.arraysAllocated += 2
      buffers = { positions: new Float32Array(64), velocities: new Float32Array(64) }
    }
    buffers.positions[0] = this.time
    const published = { ...snapshot(this.time), ...buffers }
    const received = structuredClone(published, { transfer: [buffers.positions.buffer, buffers.velocities.buffer] })
    this.onmessage?.({ data: { type: 'snapshot', generation, snapshot: received } })
  }
}

function snapshot(time: number): FluidSnapshot {
  return {
    positions: new Float32Array(), velocities: new Float32Array(), count: 0,
    diagnostics: {
      time, count: 0, injected: 0, discharged: 0, escaped: 0, stored: 0, massError: 0,
      maxVelocity: 0, wetCells: 0, reachedExit: false, outletRate: 0, saturated: false,
    },
  }
}

const project = createDefaultProject({ grid: { rows: 2, cols: 1, minimumCellPixels: 8 }, seed: 'runtime-clock' })
let now: number
let frame: FrameRequestCallback
let hidden: boolean
let runtime: FreeSurfaceRuntime | undefined
const status = vi.fn()
function setup() {
  runtime = new FreeSurfaceRuntime(document.createElement('div'), project, 'low', 'natural', vi.fn(), status, vi.fn(), vi.fn())
  const worker = FakeWorker.current
  worker.complete()
  return { runtime, worker }
}
const renderFrame = (time: number) => { now = time; frame(time) }
const advances = (worker: FakeWorker) => worker.commands.filter(command => command.type === 'advance')
const steps = (worker: FakeWorker) => advances(worker).reduce((sum, command) => sum + command.steps!, 0)

beforeEach(() => {
  now = 0; hidden = false
  vi.clearAllMocks()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => {
  runtime?.dispose(); runtime = undefined
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('free-surface runtime clock and snapshot scheduling', () => {
  it('advances a full physical second when the renderer runs at 10 fps', () => {
    const { worker } = setup()
    for (let time = 100; time <= 1_000; time += 100) {
      renderFrame(time)
      worker.complete()
    }
    expect(steps(worker)).toBe(120)
    expect(worker.time).toBeCloseTo(1, 10)
    expect(advances(worker).every(command => command.steps! <= 12)).toBe(true)
  })

  it('pumps four bounded worker batches at 4× without extra frames or duplicate time', () => {
    const { runtime, worker } = setup()
    runtime.setSpeed(4)
    renderFrame(100)
    expect(steps(worker)).toBe(12)
    for (let i = 0; i < 4; i++) worker.complete()
    expect(steps(worker)).toBe(48)
    expect(worker.time).toBeCloseTo(0.4, 10)
    expect(worker.pending).toBe(false)
    // The UI and visible surface stay on their last displayed state until rAF.
    expect(rendering.render).toHaveBeenCalledTimes(1)
    expect(status.mock.calls.at(-1)![0].simulationTime).toBe(0)
    renderFrame(100)
    expect(rendering.render).toHaveBeenCalledTimes(2)
    expect(status.mock.calls.at(-1)![0].simulationTime).toBeCloseTo(0.4, 10)
    expect(steps(worker)).toBe(48)
  })

  it('counts completion intervals once and refreshes unpublished physics on the next display demand', () => {
    const { worker } = setup()
    renderFrame(100)
    now = 125; worker.complete()
    now = 150; worker.complete()
    worker.complete()
    expect(steps(worker)).toBe(18)
    renderFrame(150)
    expect(steps(worker)).toBe(18)
    expect(rendering.render).toHaveBeenCalledTimes(2)
    expect(worker.commands.at(-1)).toMatchObject({ type: 'advance', steps: 0, publish: true })
    worker.complete()
    renderFrame(150)
    expect(rendering.render.mock.calls.at(-1)![0].diagnostics.time).toBeCloseTo(0.15, 10)
    expect(steps(worker)).toBe(18)
  })

  it('recycles transferred particle buffers across displayed frames without detaching visible data early', () => {
    const { worker } = setup()
    const visiblePositions: number[] = []
    rendering.render.mockImplementation((state: FluidSnapshot) => { visiblePositions.push(state.positions[0]) })
    for (let index = 1; index <= 120; index++) {
      renderFrame(index * 1000 / 60)
      worker.complete()
    }
    renderFrame(2000)
    expect(worker.time).toBeCloseTo(2, 10)
    expect(worker.arraysAllocated).toBeLessThanOrEqual(4)
    expect(visiblePositions).toHaveLength(120)
    expect(visiblePositions.every(Number.isFinite)).toBe(true)
    expect(visiblePositions.at(-1)).toBeCloseTo(2, 6)
  })

  it('publishes demanded frames during persistent catch-up while intermediate batches carry no particles', () => {
    const { runtime, worker } = setup()
    runtime.setSpeed(4)
    for (let time = 100; time <= 1000; time += 100) {
      renderFrame(time)
      // Work takes longer than the displayed interval can clear at 4×. A
      // frame must still receive the next completed batch, never await zero debt.
      now = time + 20; worker.complete()
      now = time + 40; worker.complete()
    }
    renderFrame(1100)
    expect(rendering.render.mock.calls.length).toBeGreaterThanOrEqual(10)
    expect(advances(worker).some(command => command.publish === false)).toBe(true)
    expect(worker.snapshots).toBeLessThan(advances(worker).length)
    expect(worker.time).toBeGreaterThan(1)
    expect(advances(worker).every(command => command.steps! <= 12)).toBe(true)
  })

  it('reuses fallback particle buffers while keeping its main-thread work bounded', () => {
    vi.stubGlobal('Worker', undefined)
    runtime = new FreeSurfaceRuntime(document.createElement('div'), project, 'low', 'natural', vi.fn(), status, vi.fn(), vi.fn())
    const first = rendering.render.mock.calls[0][0] as FluidSnapshot
    renderFrame(100)
    const current = rendering.render.mock.calls.at(-1)![0] as FluidSnapshot
    expect(current.positions).toBe(first.positions)
    expect(current.velocities).toBe(first.velocities)
    expect(current.diagnostics.time).toBeCloseTo(4 / 120, 10)
    runtime.setPaused(true)
    renderFrame(1000)
    expect(rendering.render).toHaveBeenCalledTimes(2)
  })

  it('discards pending and in-flight pause snapshots and resumes without paused-time catch-up', () => {
    const { runtime, worker } = setup()
    renderFrame(100); worker.complete()
    runtime.setPaused(true)
    renderFrame(2_000)
    expect(rendering.render).toHaveBeenCalledTimes(1)
    runtime.setPaused(false)
    renderFrame(2_100)
    runtime.setPaused(true)
    worker.complete()
    renderFrame(4_000)
    expect(rendering.render).toHaveBeenCalledTimes(1)
    expect(steps(worker)).toBe(24)
    runtime.setPaused(false)
    renderFrame(4_100); worker.complete(); renderFrame(4_100)
    expect(steps(worker)).toBe(36)
    expect(rendering.render).toHaveBeenCalledTimes(2)
  })

  it('drops hidden-tab elapsed time and pending display work', () => {
    const { worker } = setup()
    renderFrame(100); worker.complete()
    hidden = true; document.dispatchEvent(new Event('visibilitychange'))
    renderFrame(60_000)
    hidden = false; document.dispatchEvent(new Event('visibilitychange'))
    renderFrame(60_000)
    expect(steps(worker)).toBe(12)
    expect(rendering.render).toHaveBeenCalledTimes(1)
    renderFrame(60_100)
    expect(steps(worker)).toBe(24)
  })

  it('resets the generation and display without accepting old worker responses', () => {
    const { runtime, worker } = setup()
    renderFrame(100)
    runtime.restart()
    worker.complete(0)
    renderFrame(200)
    expect(worker.commands.at(-1)).toMatchObject({ type: 'reset', generation: 1 })
    expect(rendering.render).toHaveBeenCalledTimes(1)
    worker.complete(1)
    expect(rendering.render.mock.calls.at(-1)![0].diagnostics.time).toBe(0)
    expect(status.mock.calls.at(-1)![0].simulationTime).toBe(0)
    renderFrame(300)
    expect(worker.commands.at(-1)).toMatchObject({ type: 'advance', generation: 1, steps: 12 })
  })

  it('bounds recovery after a long foreground stall and clears old supply budget', () => {
    const { runtime, worker } = setup()
    runtime.setSpeed(4)
    renderFrame(10_000)
    for (let i = 0; i < 5; i++) worker.complete()
    expect(steps(worker)).toBe(60)
    expect(worker.pending).toBe(false)
    renderFrame(10_100)
    runtime.setInflow(false)
    worker.complete()
    expect(worker.pending).toBe(false)
    renderFrame(10_125)
    expect(worker.commands.at(-1)).toMatchObject({ type: 'advance', inflow: 0, steps: 12 })
  })
})
