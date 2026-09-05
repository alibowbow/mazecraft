import { FreeSurfaceSolver } from './solver'
import type { FluidLayout } from './types'

type Request =
  | { type: 'init'; layout: FluidLayout; generation: number }
  | { type: 'advance'; steps: number; inflow: number; generation: number }
  | { type: 'reset'; generation: number }

let solver: FreeSurfaceSolver | null = null
let generation = 0
self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.type === 'init') {
      generation = request.generation
      solver = new FreeSurfaceSolver(request.layout)
    } else if (request.type === 'reset') {
      generation = request.generation
      solver?.reset()
    } else if (solver && request.generation === generation) {
      const steps = Math.min(12, Math.max(0, Math.floor(request.steps)))
      for (let i = 0; i < steps; i++) solver.step(1 / 120, request.inflow)
    } else return
    if (!solver) return
    const snapshot = solver.snapshot()
    self.postMessage({ type: 'snapshot', generation, snapshot }, {
      transfer: [snapshot.positions.buffer, snapshot.velocities.buffer],
    })
  } catch (error) {
    self.postMessage({ type: 'error', generation, message: String(error) })
  }
}
