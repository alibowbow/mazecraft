import type { MazeProject } from '../../../core/maze'
import type { WaterSurfaceStyle } from '../rendering'
import type { ResolvedWaterQuality, WaterPlaybackStatus, WaterRuntimeMetrics } from '../waterSceneRuntime'
import { buildFluidLayout } from './layout'
import { FreeSurfaceRenderer } from './renderer'
import { FreeSurfaceSolver } from './solver'
import type { FluidDiagnostics, FluidSnapshot } from './types'

export interface FreeSurfaceStatus extends WaterPlaybackStatus {
  particleCount: number
  escapedVolume: number
  saturated: boolean
}

/** One bounded worker request in flight. Wall-clock lag never enlarges dt. */
export class FreeSurfaceRuntime {
  private readonly layout
  private readonly renderer: FreeSurfaceRenderer
  private worker: Worker | null = null
  private fallback: FreeSurfaceSolver | null = null
  private snapshot: FluidSnapshot | null = null
  private pendingSnapshot: FluidSnapshot | null = null
  private generation = 0
  private busy = true
  private ready = false
  private disposed = false
  private paused = false
  private speed = 1
  private inflow = 1
  private debt = 0
  private lastAdvance: number | null = null
  private lastPublish = 0
  private frameId = 0
  private watchdog: ReturnType<typeof setTimeout> | undefined

  constructor(
    mount: HTMLElement,
    project: MazeProject,
    private readonly quality: ResolvedWaterQuality,
    style: WaterSurfaceStyle,
    private readonly onReady: () => void,
    private readonly onStatus: (status: FreeSurfaceStatus) => void,
    private readonly onError: (message: string) => void,
    private readonly onMetrics: (metrics: WaterRuntimeMetrics) => void,
    _reducedMotion = false,
  ) {
    this.layout = buildFluidLayout(project)
    this.renderer = new FreeSurfaceRenderer(mount, this.layout, quality)
    this.renderer.setSurfaceStyle(style)
    try {
      if (typeof Worker === 'undefined') throw new Error('Worker unavailable')
      this.worker = new Worker(new URL('./fluid.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = ({ data }) => {
        if (this.disposed || data.generation !== this.generation) return
        if (data.type === 'error') { this.failWorker(); return }
        this.busy = false
        // A message already in flight must never change a paused image.
        if (this.ready && (this.paused || document.hidden)) return
        if (!this.ready) this.accept(data.snapshot as FluidSnapshot)
        else this.pendingSnapshot = data.snapshot as FluidSnapshot
        // Keep the worker occupied while the GPU renders the previous state.
        // Several completed batches may share one displayed animation frame.
        this.advance(performance.now())
      }
      this.worker.onerror = () => this.failWorker()
      this.worker.postMessage({ type: 'init', layout: this.layout, generation: this.generation })
      this.watchdog = setTimeout(() => { if (!this.ready) this.failWorker() }, 8000)
    } catch {
      this.startFallback()
    }
    document.addEventListener('visibilitychange', this.visibilityChanged)
    this.frameId = requestAnimationFrame(this.tick)
  }

  private startFallback() {
    if (this.disposed) return
    this.worker?.terminate()
    this.worker = null
    clearTimeout(this.watchdog)
    this.fallback = new FreeSurfaceSolver(this.layout)
    this.busy = false
    this.accept(this.fallback.snapshot())
  }

  private failWorker() {
    if (this.disposed) return
    if (!this.ready) { this.startFallback(); return }
    this.worker?.terminate()
    this.worker = null
    this.paused = true
    this.onError('유체 계산이 중단됐습니다. 창을 다시 열어 주세요.')
  }

  private accept(snapshot: FluidSnapshot) {
    this.snapshot = snapshot
    this.renderer.render(snapshot)
    if (!this.ready) {
      this.ready = true
      this.lastAdvance = performance.now()
      clearTimeout(this.watchdog)
      this.onReady()
      this.publish(snapshot.diagnostics)
    } else if (performance.now() - this.lastPublish >= 100) {
      this.publish(snapshot.diagnostics)
    }
  }

  private publish(d: FluidDiagnostics) {
    this.lastPublish = performance.now()
    this.onStatus({
      elapsedMs: d.time * 1000, simulationTime: d.time,
      filledCells: d.wetCells, totalCells: this.layout.activeCellCount,
      reachedExit: d.reachedExit, complete: false,
      inletState: this.inflow ? 'steady' : 'off',
      inletVisible: this.inflow > 0 && d.count > 0,
      outletVisible: d.reachedExit && d.outletRate > 0,
      activeFlowEdgeCount: 0,
      cumulativeInjectedVolume: d.injected,
      cumulativeOutletVolume: d.discharged,
      currentStoredVolume: d.stored,
      absoluteMassError: d.massError,
      relativeMassError: d.injected ? d.massError / d.injected : 0,
      maxVelocity: d.maxVelocity, outletDischarge: d.outletRate,
      particleCount: d.count, escapedVolume: d.escaped, saturated: d.saturated,
    })
    this.onMetrics({
      atlasWidth: this.renderer.canvas.width, atlasHeight: this.renderer.canvas.height,
      closedWallLeakTexels: 0, drawCalls: this.renderer.metrics?.drawCalls ?? 0,
      triangles: this.renderer.metrics?.triangles ?? 0,
      inletDropHeight: this.layout.topY - this.layout.inletY,
      inletContactGap: 0, outletDropHeight: this.layout.maxY - this.layout.outletY,
      physicsStepHz: 120, snapshotHz: 60,
      solverMode: this.worker ? 'worker' : 'main-thread', waveBands: 0, foamMode: 'procedural',
    })
  }

  private advance(now: number) {
    if (this.disposed) return
    // A 50 ms frame clamp made 10 fps rendering run physics at half speed.
    // Preserve ordinary slow frames, but bound catch-up after a long stall.
    const delta = this.lastAdvance === null ? 0 : Math.min(0.25, Math.max(0, (now - this.lastAdvance) / 1000))
    this.lastAdvance = now
    if (this.ready && !this.paused && !document.hidden) {
      this.debt = Math.min(0.5, this.debt + delta * this.speed)
      const steps = Math.min(this.fallback ? 4 : 12, Math.floor(this.debt * 120 + 1e-7))
      if (steps && !this.busy) {
        this.debt -= steps / 120
        if (this.worker) {
          this.busy = true
          this.worker.postMessage({ type: 'advance', steps, inflow: this.inflow, generation: this.generation })
        } else if (this.fallback) {
          for (let i = 0; i < steps; i++) this.fallback.step(1 / 120, this.inflow)
          this.accept(this.fallback.snapshot())
        }
      }
    }
  }

  private tick = () => {
    if (this.disposed) return
    this.advance(performance.now())
    if (this.pendingSnapshot && !this.paused && !document.hidden) {
      const snapshot = this.pendingSnapshot
      this.pendingSnapshot = null
      this.accept(snapshot)
    }
    this.frameId = requestAnimationFrame(this.tick)
  }

  private visibilityChanged = () => { this.lastAdvance = null; this.debt = 0; this.pendingSnapshot = null }
  setSpeed(value: number) {
    this.speed = Math.max(0.1, Math.min(4, value))
    this.debt = 0
    this.lastAdvance = performance.now()
  }
  setPaused(value: boolean) {
    this.paused = value
    this.debt = 0
    this.lastAdvance = performance.now()
    this.pendingSnapshot = null
    if (this.snapshot) this.publish(this.snapshot.diagnostics)
  }
  setInflow(value: boolean) {
    this.inflow = value ? 1 : 0
    this.debt = 0
    this.lastAdvance = performance.now()
    this.renderer.setInflow(value)
    if (this.snapshot) this.publish(this.snapshot.diagnostics)
  }
  setViewMode(mode: 'free-surface' | 'surface-3d') {
    this.renderer.setViewMode(mode)
    if (this.snapshot) this.publish(this.snapshot.diagnostics)
  }
  setSurfaceStyle(style: WaterSurfaceStyle) {
    this.renderer.setSurfaceStyle(style)
    if (this.snapshot) this.renderer.render(this.snapshot)
  }
  resetCamera() { this.renderer.resetCamera() }
  restart() {
    this.generation++
    this.paused = false
    this.inflow = 1
    this.renderer.setInflow(true)
    this.debt = 0
    this.lastAdvance = null
    this.lastPublish = 0
    this.ready = false
    this.snapshot = null
    this.pendingSnapshot = null
    if (this.worker) {
      this.busy = true
      this.worker.postMessage({ type: 'reset', generation: this.generation })
    } else {
      this.fallback?.reset()
      if (this.fallback) this.accept(this.fallback.snapshot())
    }
  }
  dispose() {
    this.disposed = true
    clearTimeout(this.watchdog)
    cancelAnimationFrame(this.frameId)
    document.removeEventListener('visibilitychange', this.visibilityChanged)
    this.worker?.terminate()
    this.worker = null
    this.fallback = null
    this.snapshot = null
    this.pendingSnapshot = null
    this.renderer.dispose()
  }
}
