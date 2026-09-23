import type { MazeProject } from '../../../core/maze'
import type { WaterSurfaceStyle } from '../rendering'
import type { ResolvedWaterQuality, WaterPlaybackStatus, WaterRuntimeMetrics } from '../waterSceneRuntime'
import { buildFluidLayout } from './layout'
import { FreeSurfaceRenderer } from './renderer'
import { FreeSurfaceSolver } from './solver'
import { BasinSimulation, type BasinSnapshot } from './basinSimulation'
import { GardenSimulation } from '../garden/simulation'
import { gardenLayout } from '../garden/layout'
import { gardenIdOf, type WaterSculpture } from '../garden'
import type { FluidDiagnostics, FluidSnapshot, FluidSnapshotBuffers, FluidResume } from './types'
import type { WaterAppearance } from './appearance'
import type { WaterLook } from './lookdev'

export interface FreeSurfaceStatus extends WaterPlaybackStatus {
  particleCount: number
  escapedVolume: number
  saturated: boolean
}

const EMPTY_PARTICLE_DIAGNOSTICS: FluidDiagnostics = {
  time: 0, count: 0, injected: 0, discharged: 0, escaped: 0, stored: 0, massError: 0,
  maxVelocity: 0, wetCells: 0, reachedExit: false, outletRate: 0, saturated: false,
}

/** One bounded worker request in flight. Wall-clock lag never enlarges dt. */
export class FreeSurfaceRuntime {
  private readonly layout
  private readonly renderer: FreeSurfaceRenderer
  private readonly basin: BasinSimulation | GardenSimulation
  private basinSnapshot: BasinSnapshot
  private viewMode: 'free-surface' | 'surface-3d' = 'free-surface'
  private worker: Worker | null = null
  private fallback: FreeSurfaceSolver | null = null
  private diagnostics: FluidDiagnostics | null = null
  private pendingSnapshot: FluidSnapshot | null = null
  private readonly recycledBuffers: FluidSnapshotBuffers[] = []
  private fallbackBuffers: FluidSnapshotBuffers | undefined
  private displayRequested = false
  private refineAfterCatchUp = false
  private workerDirty = false
  private generation = 0
  private busy = true
  private ready = false
  private announcedReady = false
  private disposed = false
  private paused = false
  private speed = 1
  private inflow = 1
  private inflowRate = 1
  private inflowEnabled = true
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
    private readonly sculpture?: WaterSculpture,
    private readonly resume?: FluidResume,
  ) {
    this.layout = buildFluidLayout(project, resume?.capacity)
    if (resume) { this.layout.capacity = Math.max(this.layout.capacity, resume.snapshot.count); this.paused = resume.paused; this.inflowEnabled = resume.inflow; this.inflow = resume.inflow ? 1 : 0 }
    const garden = gardenIdOf(sculpture)
    this.basin = garden
      ? new GardenSimulation(gardenLayout(garden), this.layout)
      : new BasinSimulation(project, this.layout)
    this.basinSnapshot = this.basin.snapshot()
    this.renderer = new FreeSurfaceRenderer(mount, this.layout, quality, sculpture)
    if (this.sculpture !== 'extruded-flow') this.renderer.setBasinSnapshot(this.basinSnapshot)
    this.renderer.setSurfaceStyle(style)
    try {
      if (typeof Worker === 'undefined') throw new Error('Worker unavailable')
      this.worker = new Worker(new URL('./fluid.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = ({ data }) => {
        if (this.disposed || !this.worker) return
        if (data.generation !== this.generation) {
          if (data.snapshot) this.recycle(data.snapshot as FluidSnapshot)
          return
        }
        if (data.type === 'error') { this.failWorker(); return }
        this.busy = false
        if (data.type === 'advanced') {
          this.workerDirty = true
          this.advance(performance.now())
          return
        }
        this.workerDirty = false
        // A message already in flight must never change a paused image.
        if (this.ready && (this.paused || document.hidden)) {
          this.recycle(data.snapshot as FluidSnapshot)
          this.workerDirty = true
          return
        }
        if (!this.ready) this.accept(data.snapshot as FluidSnapshot)
        else {
          this.releasePending()
          this.pendingSnapshot = data.snapshot as FluidSnapshot
        }
        // Keep the worker occupied while the GPU renders the previous state.
        // Several completed batches may share one displayed animation frame.
        this.advance(performance.now())
      }
      this.worker.onerror = () => this.failWorker()
      this.worker.postMessage({ type: 'init', layout: this.layout, generation: this.generation, resume: this.resume })
      this.watchdog = setTimeout(() => { if (!this.ready) this.failWorker() }, 8000)
    } catch {
      this.startFallback()
    }
    document.addEventListener('visibilitychange', this.visibilityChanged)
    this.frameId = requestAnimationFrame(this.tick)
  }

  private get basinMode(): boolean { return this.viewMode === 'surface-3d' && this.sculpture !== 'extruded-flow' }

  private startFallback() {
    if (this.disposed) return
    this.worker?.terminate()
    this.worker = null
    this.recycledBuffers.length = 0
    clearTimeout(this.watchdog)
    this.fallback = new FreeSurfaceSolver(this.layout)
    if (this.resume && !this.ready && this.generation === 0) this.fallback.restore(this.resume)
    this.fallbackBuffers = {
      positions: new Float32Array(this.layout.capacity * 2),
      velocities: new Float32Array(this.layout.capacity * 2),
    }
    this.busy = false
    this.accept(this.fallback.snapshot(this.fallbackBuffers))
  }

  private failWorker() {
    if (this.disposed) return
    if (!this.ready || this.basinMode) { this.startFallback(); return }
    this.worker?.terminate()
    this.worker = null
    this.paused = true
    this.onError('유체 계산이 중단됐습니다. 창을 다시 열어 주세요.')
  }

  private accept(snapshot: FluidSnapshot) {
    this.diagnostics = snapshot.diagnostics
    this.renderer.render(snapshot)
    if (this.worker) this.recycle(snapshot)
    if (!this.ready) {
      this.ready = true
      if (!this.basinMode) this.lastAdvance = performance.now()
      clearTimeout(this.watchdog)
      this.announceReady()
      this.publish(snapshot.diagnostics)
    } else if (performance.now() - this.lastPublish >= 100) {
      this.publish(snapshot.diagnostics)
    }
  }

  private announceReady() {
    if (this.announcedReady) return
    this.announcedReady = true
    this.onReady()
  }

  private publishCurrent() {
    if (this.basinMode) this.publish(this.basinSnapshot.diagnostics)
    else this.publish(this.diagnostics ?? EMPTY_PARTICLE_DIAGNOSTICS)
  }

  private recycle(snapshot: FluidSnapshotBuffers) {
    if (snapshot.positions.byteLength && snapshot.velocities.byteLength) {
      this.recycledBuffers.push({ positions: snapshot.positions, velocities: snapshot.velocities })
    }
  }

  private releasePending() {
    if (this.pendingSnapshot) this.recycle(this.pendingSnapshot)
    this.pendingSnapshot = null
  }

  private publish(d: FluidDiagnostics) {
    const basinMode = this.basinMode
    if (basinMode) d = this.basinSnapshot.diagnostics
    const availableVolume = d.injected + (basinMode ? this.basinSnapshot.initialStoredVolume : 0)
    this.lastPublish = performance.now()
    this.onStatus({
      elapsedMs: d.time * 1000, simulationTime: d.time,
      filledCells: d.wetCells, totalCells: this.layout.activeCellCount,
      reachedExit: d.reachedExit, complete: false,
      inletState: this.inflow ? 'steady' : 'off',
      inletVisible: this.inflow > 0 && (basinMode ? this.basinSnapshot.sourceRate > 0 : d.count > 0),
      outletVisible: d.reachedExit && d.outletRate > 0,
      activeFlowEdgeCount: 0,
      cumulativeInjectedVolume: d.injected,
      cumulativeOutletVolume: d.discharged,
      currentStoredVolume: d.stored,
      absoluteMassError: d.massError,
      relativeMassError: availableVolume ? d.massError / availableVolume : 0,
      maxVelocity: d.maxVelocity, outletDischarge: d.outletRate,
      particleCount: basinMode ? 0 : d.count, escapedVolume: d.escaped, saturated: d.saturated,
    })
    this.onMetrics({
      atlasWidth: this.renderer.canvas.width, atlasHeight: this.renderer.canvas.height,
      closedWallLeakTexels: 0, drawCalls: this.renderer.metrics?.drawCalls ?? 0,
      triangles: this.renderer.metrics?.triangles ?? 0,
      inletDropHeight: this.layout.topY - this.layout.inletY,
      inletContactGap: 0, outletDropHeight: this.layout.maxY - this.layout.outletY,
      physicsStepHz: 120, snapshotHz: 60,
      solverMode: !basinMode && this.worker ? 'worker' : 'main-thread', waveBands: basinMode ? 3 : 0, foamMode: 'procedural',
    })
  }

  private advance(now: number) {
    if (this.disposed) return
    // A 50 ms frame clamp made 10 fps rendering run physics at half speed.
    // Preserve ordinary slow frames, but bound catch-up after a long stall.
    const delta = this.lastAdvance === null ? 0 : Math.min(0.25, Math.max(0, (now - this.lastAdvance) / 1000))
    this.lastAdvance = now
    // A horizontal basin has its own conserved cell volumes. It must not wait
    // for the unrelated falling-particle worker, or inherit its sparse mask.
    // Inactive modes keep their state and resume without hidden-time catch-up.
    if (this.basinMode) {
      if (this.paused || document.hidden) return
      this.debt = Math.min(0.5, this.debt + delta * this.speed)
      let seconds = Math.floor(this.debt * 120 + 1e-7) / 120
      this.debt -= seconds
      if (seconds <= 0) return
      while (seconds > 1e-8) {
        const batch = Math.min(0.25, seconds)
        this.basin.advance(batch, this.inflow)
        seconds -= batch
      }
      this.basinSnapshot = this.basin.snapshot()
      if (this.sculpture !== 'extruded-flow') this.renderer.setBasinSnapshot(this.basinSnapshot)
      if (now - this.lastPublish >= 100) this.publish(this.basinSnapshot.diagnostics)
      return
    }
    if (this.ready && !this.paused && !document.hidden) {
      this.debt = Math.min(0.5, this.debt + delta * this.speed)
      const steps = Math.min(this.fallback ? 4 : 12, Math.floor(this.debt * 120 + 1e-7))
      const refresh = this.worker && this.displayRequested && this.workerDirty
      if ((steps || refresh) && !this.busy) {
        this.debt -= steps / 120
        if (this.worker) {
          this.busy = true
          // Demand comes from rAF, not worker completion speed. Publish the
          // next completed batch even while behind so catch-up never starves
          // the display; intervening batches return lightweight acknowledgements.
          // One final catch-up refinement keeps the latest completed state when
          // several fixed batches finish within that same displayed frame.
          const stillBehind = Math.floor(this.debt * 120 + 1e-7) > 0
          const publish = this.displayRequested || (this.refineAfterCatchUp && !stillBehind)
          if (this.displayRequested) {
            this.displayRequested = false
            this.refineAfterCatchUp = stillBehind
          } else if (publish) this.refineAfterCatchUp = false
          const buffers = this.recycledBuffers.pop()
          this.worker.postMessage({ type: 'advance', steps, inflow: this.inflow, generation: this.generation, publish, buffers },
            buffers ? { transfer: [buffers.positions.buffer, buffers.velocities.buffer] } : undefined)
        } else if (this.fallback) {
          for (let i = 0; i < steps; i++) this.fallback.step(1 / 120, this.inflow)
          this.accept(this.fallback.snapshot(this.fallbackBuffers))
        }
      }
    }
  }

  private tick = () => {
    if (this.disposed) return
    const now = performance.now()
    if (!this.basinMode && this.ready && !this.paused && !document.hidden) this.displayRequested = true
    this.advance(now)
    if (this.pendingSnapshot && !this.paused && !document.hidden) {
      const snapshot = this.pendingSnapshot
      this.pendingSnapshot = null
      this.accept(snapshot)
    }
    this.frameId = requestAnimationFrame(this.tick)
  }

  private visibilityChanged = () => {
    this.lastAdvance = null; this.debt = 0; this.displayRequested = false; this.refineAfterCatchUp = false
    this.releasePending()
  }
  setSpeed(value: number) {
    this.speed = Math.max(0.1, Math.min(4, value))
    this.debt = 0
    this.lastAdvance = performance.now()
  }
  setPaused(value: boolean) {
    this.paused = value
    this.displayRequested = false
    this.refineAfterCatchUp = false
    this.debt = 0
    this.lastAdvance = performance.now()
    this.releasePending()
    this.publishCurrent()
  }
  setInflow(value: boolean) {
    this.inflowEnabled = value
    this.inflow = value ? this.inflowRate : 0
    this.debt = 0
    this.lastAdvance = performance.now()
    this.renderer.setInflow(value)
    this.publishCurrent()
  }
  setInflowRate(value: number) {
    if (!Number.isFinite(value)) return
    this.inflowRate = Math.max(0.1, Math.min(2.5, value))
    this.inflow = this.inflowEnabled ? this.inflowRate : 0
    this.debt = 0
    this.lastAdvance = performance.now()
    this.publishCurrent()
  }
  setViewMode(mode: 'free-surface' | 'surface-3d') {
    if (this.viewMode !== mode) {
      this.viewMode = mode
      this.debt = 0
      this.lastAdvance = performance.now()
      this.displayRequested = false
      this.refineAfterCatchUp = false
    }
    this.renderer.setViewMode(mode)
    if (this.basinMode) {
      this.announceReady()
      this.publish(this.basinSnapshot.diagnostics)
    } else this.publishCurrent()
  }
  setSurfaceStyle(style: WaterSurfaceStyle) {
    this.renderer.setSurfaceStyle(style)
  }
  setAppearance(appearance: WaterAppearance) { this.renderer.setAppearance(appearance) }
  setLook(look: Partial<WaterLook>) {
    if (typeof look.wallHeight === 'number' && Number.isFinite(look.wallHeight)) {
      this.basin.setWallHeight(look.wallHeight)
      this.basinSnapshot = this.basin.snapshot()
      if (this.sculpture !== 'extruded-flow') this.renderer.setBasinSnapshot(this.basinSnapshot)
    }
    this.renderer.setLook(look)
  }
  captureFlowState(): FluidResume | undefined {
    if (this.basinMode || !this.diagnostics) return undefined
    return { snapshot: this.renderer.captureParticles(this.diagnostics), capacity: this.layout.capacity, rows: this.layout.rows, cols: this.layout.cols,
      inletX: this.layout.inletX, outletX: this.layout.outletX, topY: this.layout.topY, bottomY: this.layout.bottomY,
      outletY: this.layout.outletY, paused: this.paused, inflow: this.inflowEnabled }
  }
  pointAt(clientX: number, clientY: number) { return this.renderer.pointAt(clientX, clientY) }
  resetCamera() { this.renderer.resetCamera() }
  zoomCamera(factor: number) { this.renderer.zoomCamera(factor) }
  restart() {
    this.generation++
    this.paused = true
    this.inflowEnabled = true
    this.inflow = this.inflowRate
    this.renderer.setInflow(true)
    this.debt = 0
    this.lastAdvance = null
    this.lastPublish = 0
    this.ready = false
    this.announcedReady = false
    this.displayRequested = false
    this.refineAfterCatchUp = false
    this.workerDirty = false
    this.diagnostics = null
    this.releasePending()
    this.basin.reset()
    this.basinSnapshot = this.basin.snapshot()
    if (this.sculpture !== 'extruded-flow') this.renderer.setBasinSnapshot(this.basinSnapshot)
    if (this.basinMode) {
      this.lastAdvance = performance.now()
      this.announceReady()
      this.publish(this.basinSnapshot.diagnostics)
    }
    if (this.worker) {
      this.busy = true
      const buffers = this.recycledBuffers.pop()
      this.worker.postMessage({ type: 'reset', generation: this.generation, buffers },
        buffers ? { transfer: [buffers.positions.buffer, buffers.velocities.buffer] } : undefined)
    } else {
      this.fallback?.reset()
      if (this.fallback) this.accept(this.fallback.snapshot(this.fallbackBuffers))
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
    this.diagnostics = null
    this.pendingSnapshot = null
    this.recycledBuffers.length = 0
    this.fallbackBuffers = undefined
    this.renderer.dispose()
  }
}
