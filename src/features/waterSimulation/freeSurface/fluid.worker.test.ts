import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FluidSnapshot, FluidSnapshotBuffers } from './types'

const simulation = vi.hoisted(() => ({ step: vi.fn(), reset: vi.fn(), snapshot: vi.fn() }))
vi.mock('./solver', () => ({
  FreeSurfaceSolver: class {
    step = simulation.step
    reset = simulation.reset
    snapshot = simulation.snapshot
  },
}))

let scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown, options?: StructuredSerializeOptions) => void }
let responses: Array<{ type: string; generation: number; snapshot?: FluidSnapshot }>
function request(message: unknown, buffers?: FluidSnapshotBuffers) {
  const data = structuredClone(message, buffers ? { transfer: [buffers.positions.buffer, buffers.velocities.buffer] } : undefined)
  scope.onmessage!({ data })
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks()
  responses = []
  simulation.snapshot.mockImplementation((buffers: FluidSnapshotBuffers) => ({
    ...buffers, count: 2,
    diagnostics: { time: 1, count: 2, massError: 0 },
  }))
  scope = {
    onmessage: null,
    postMessage: (message, options) => { responses.push(structuredClone(message, options) as (typeof responses)[number]) },
  }
  vi.stubGlobal('self', scope)
  await import('./fluid.worker')
  request({ type: 'init', layout: { capacity: 8 }, generation: 0 })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('free-surface worker buffer ownership', () => {
  it('acknowledges unpublished fixed steps without scanning or copying particles and reuses returned buffers', () => {
    const initial = responses.at(-1)!.snapshot!
    initial.positions[0] = 123
    request({ type: 'advance', generation: 0, steps: 4, inflow: 1, publish: false, buffers: initial }, initial)
    expect(initial.positions.byteLength).toBe(0)
    expect(initial.velocities.byteLength).toBe(0)
    expect(simulation.step).toHaveBeenCalledTimes(4)
    expect(simulation.step).toHaveBeenLastCalledWith(1 / 120, 1)
    expect(simulation.snapshot).toHaveBeenCalledTimes(1)
    expect(responses.at(-1)).toEqual({ type: 'advanced', generation: 0 })

    request({ type: 'advance', generation: 0, steps: 0, inflow: 1, publish: true })
    expect(simulation.snapshot).toHaveBeenCalledTimes(2)
    expect(responses.at(-1)!.snapshot!.positions[0]).toBe(123)
    expect(responses.at(-1)!.snapshot!.positions.length).toBe(16)
    expect(simulation.step).toHaveBeenCalledTimes(4)
  })

  it('keeps both returned buffer pairs while physics runs and uses them without replacement allocations', () => {
    const first = responses.at(-1)!.snapshot!
    first.positions[0] = 11
    request({ type: 'advance', generation: 0, steps: 1, inflow: 1, publish: true })
    const second = responses.at(-1)!.snapshot!
    second.positions[0] = 22
    request({ type: 'advance', generation: 0, steps: 1, inflow: 1, publish: false, buffers: first }, first)
    request({ type: 'advance', generation: 0, steps: 1, inflow: 1, publish: false, buffers: second }, second)
    request({ type: 'advance', generation: 0, steps: 0, inflow: 1, publish: true })
    expect(responses.at(-1)!.snapshot!.positions[0]).toBe(22)
    request({ type: 'advance', generation: 0, steps: 0, inflow: 1, publish: true })
    expect(responses.at(-1)!.snapshot!.positions[0]).toBe(11)
  })

  it('resets the generation and rejects stale work without altering the new solver', () => {
    const buffers = responses.at(-1)!.snapshot!
    request({ type: 'reset', generation: 1, buffers }, buffers)
    expect(simulation.reset).toHaveBeenCalledOnce()
    expect(responses.at(-1)).toMatchObject({ type: 'snapshot', generation: 1 })
    const responseCount = responses.length
    request({ type: 'advance', generation: 0, steps: 12, inflow: 1, publish: true })
    expect(simulation.step).not.toHaveBeenCalled()
    expect(responses).toHaveLength(responseCount)
  })
})
