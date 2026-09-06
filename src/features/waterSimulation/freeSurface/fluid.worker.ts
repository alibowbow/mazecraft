import { FreeSurfaceSolver } from './solver'
import type { FluidLayout, FluidSnapshotBuffers } from './types'

type Request =
  | { type: 'init'; layout: FluidLayout; generation: number }
  | { type: 'advance'; steps: number; inflow: number; generation: number; publish: boolean; buffers?: FluidSnapshotBuffers }
  | { type: 'reset'; generation: number; buffers?: FluidSnapshotBuffers }

let solver: FreeSurfaceSolver | null = null
let generation = 0
const recycledBuffers: FluidSnapshotBuffers[] = []
let capacity = 0
self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.type === 'init') {
      generation = request.generation
      solver = new FreeSurfaceSolver(request.layout)
      capacity = request.layout.capacity * 2
      recycledBuffers.length = 0
    } else if (request.type === 'reset') {
      generation = request.generation
      solver?.reset()
    } else if (solver && request.generation === generation) {
      const steps = Math.min(12, Math.max(0, Math.floor(request.steps)))
      for (let i = 0; i < steps; i++) solver.step(1 / 120, request.inflow)
    } else return
    if (!solver) return
    if ('buffers' in request && request.buffers) recycledBuffers.push(request.buffers)
    if (request.type === 'advance' && !request.publish) {
      // Physics can finish several batches between displayed frames. These
      // acknowledgements need neither a particle copy nor a diagnostics scan.
      self.postMessage({ type: 'advanced', generation })
      return
    }
    const buffers = recycledBuffers.pop() ?? { positions: new Float32Array(capacity), velocities: new Float32Array(capacity) }
    const snapshot = solver.snapshot(buffers)
    self.postMessage({ type: 'snapshot', generation, snapshot }, {
      transfer: [snapshot.positions.buffer, snapshot.velocities.buffer],
    })
  } catch (error) {
    self.postMessage({ type: 'error', generation, message: String(error) })
  }
}
