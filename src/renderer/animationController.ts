import type { MazeParticle, MazePoint, MazeRenderFrame } from './types'

export type MazeAnimationMode = 'path' | 'water' | 'particle'
export type MazeAnimationPhase =
  | 'searching'
  | 'found'
  | 'revealing'
  | 'draining'
  | 'complete'

export interface ParticleDensitySettings {
  value: number
  particleSize: number
  spawnIntervalMs: number
  maxParticles: number
  overlap: number
}

export interface MazeAnimationSnapshot {
  mode: MazeAnimationMode
  phase: MazeAnimationPhase
  elapsedMs: number
  solutionProgress: number
  revealedCells: ReadonlyArray<MazePoint>
  waterOpacity: number
  particles: ReadonlyArray<MazeParticle>
}

export interface MazeAnimationRequest {
  mode: MazeAnimationMode
  path: ReadonlyArray<MazePoint>
  density?: number
  color?: string
  /**
   * Defaults are length-aware. Supplying a value is useful for recorded demos
   * and tests, while reduced motion still wins over this duration.
   */
  revealDurationMs?: number
}

export interface MazeAnimationControllerOptions {
  onFrame: (snapshot: MazeAnimationSnapshot) => void
  onPhaseChange?: (phase: MazeAnimationPhase) => void
  reducedMotion?: boolean
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
  now?: () => number
}

interface SimulatedParticle extends MazeParticle {
  velocityX: number
  velocityY: number
  bornAt: number
  lifetimeMs: number
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

export const resolveParticleDensity = (rawValue: number): ParticleDensitySettings => {
  const value = Math.round(clamp(Number.isFinite(rawValue) ? rawValue : 4, 1, 10))
  return {
    value,
    particleSize: 0.045 + value * 0.006,
    spawnIntervalMs: Math.round(104 - value * 8),
    maxParticles: 56 + value * 28,
    overlap: 0.08 + value * 0.085,
  }
}

/**
 * Convenience bridge for consumers that render controller snapshots with
 * MazeCanvas. Callers can merge the result over their player/ghost frame.
 */
export const animationSnapshotToRenderFrame = (
  snapshot: MazeAnimationSnapshot,
): Pick<MazeRenderFrame, 'solution' | 'solutionProgress' | 'water' | 'particles'> => ({
  solution:
    snapshot.mode === 'path' || snapshot.phase === 'complete'
      ? snapshot.revealedCells
      : undefined,
  solutionProgress:
    snapshot.mode === 'path' || snapshot.phase === 'complete'
      ? snapshot.solutionProgress
      : 0,
  water:
    snapshot.mode === 'water'
      ? {
          cells: snapshot.revealedCells,
          opacity: snapshot.waterOpacity,
        }
      : null,
  particles: snapshot.mode === 'particle' ? snapshot.particles : [],
})

const defaultSnapshot = (
  mode: MazeAnimationMode,
  phase: MazeAnimationPhase,
): MazeAnimationSnapshot => ({
  mode,
  phase,
  elapsedMs: 0,
  solutionProgress: phase === 'complete' ? 1 : 0,
  revealedCells: [],
  waterOpacity: phase === 'complete' ? 1 : 0,
  particles: [],
})

/**
 * A single owner for every solution-animation RAF. Starting another animation,
 * navigating away, or disposing always cancels the previous frame first.
 */
export class MazeAnimationController {
  private readonly onFrame: MazeAnimationControllerOptions['onFrame']
  private readonly onPhaseChange?: MazeAnimationControllerOptions['onPhaseChange']
  private readonly requestFrame: (callback: FrameRequestCallback) => number
  private readonly cancelFrame: (id: number) => void
  private readonly now: () => number
  private readonly reducedMotionOverride?: boolean
  private frameId: number | null = null
  private runToken = 0
  private phase: MazeAnimationPhase = 'complete'
  private particles: SimulatedParticle[] = []
  private particleSequence = 0
  private lastParticleAt = 0
  private lastFrameAt = 0
  private pendingResolve: ((phase: MazeAnimationPhase) => void) | null = null

  constructor(options: MazeAnimationControllerOptions) {
    this.onFrame = options.onFrame
    this.onPhaseChange = options.onPhaseChange
    this.reducedMotionOverride = options.reducedMotion
    this.requestFrame =
      options.requestFrame ??
      ((callback) => {
        if (typeof requestAnimationFrame === 'function') {
          return requestAnimationFrame(callback)
        }
        return window.setTimeout(() => callback(this.now()), 16)
      })
    this.cancelFrame =
      options.cancelFrame ??
      ((id) => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
        else window.clearTimeout(id)
      })
    this.now = options.now ?? (() => performance.now())
  }

  getPhase(): MazeAnimationPhase {
    return this.phase
  }

  isRunning(): boolean {
    return this.frameId !== null
  }

  play(request: MazeAnimationRequest): Promise<MazeAnimationPhase> {
    this.cancel()
    const token = ++this.runToken
    const path = request.path.map((point) => ({ row: point.row, col: point.col }))
    const reducedMotion = this.prefersReducedMotion()

    if (path.length === 0 || reducedMotion) {
      this.setPhase('complete')
      if (token !== this.runToken) return Promise.resolve(this.phase)
      this.onFrame({
        ...defaultSnapshot(request.mode, 'complete'),
        revealedCells: path,
      })
      return Promise.resolve('complete')
    }

    const density = resolveParticleDensity(request.density ?? 4)
    const revealDuration = Math.max(
      220,
      request.revealDurationMs ?? clamp(path.length * 24, 550, 5500),
    )
    const searchingDuration = request.mode === 'water' ? 260 : 80
    const foundDuration = 140
    const drainingDuration = request.mode === 'water' ? 520 : 180
    const totalDuration =
      searchingDuration + foundDuration + revealDuration + drainingDuration
    const startedAt = this.now()
    this.lastFrameAt = startedAt
    this.lastParticleAt = startedAt
    this.particles = []
    this.particleSequence = 0
    this.setPhase('searching')
    if (token !== this.runToken) return Promise.resolve(this.phase)

    return new Promise((resolve) => {
      this.pendingResolve = resolve
      const tick = (frameTime: number): void => {
        if (token !== this.runToken) return
        const now = Number.isFinite(frameTime) ? frameTime : this.now()
        const elapsed = Math.max(0, now - startedAt)
        const delta = clamp(now - this.lastFrameAt, 0, 34)
        this.lastFrameAt = now

        let phase: MazeAnimationPhase
        let progress = 0
        let waterOpacity = 0

        if (elapsed < searchingDuration) {
          phase = 'searching'
        } else if (elapsed < searchingDuration + foundDuration) {
          phase = 'found'
          waterOpacity = request.mode === 'water' ? 0.16 : 0
        } else if (elapsed < searchingDuration + foundDuration + revealDuration) {
          phase = 'revealing'
          progress = clamp(
            (elapsed - searchingDuration - foundDuration) / revealDuration,
            0,
            1,
          )
          waterOpacity = request.mode === 'water' ? 0.92 : 0
        } else if (elapsed < totalDuration) {
          phase = 'draining'
          progress = 1
          const drainProgress =
            (elapsed - searchingDuration - foundDuration - revealDuration) /
            drainingDuration
          waterOpacity = request.mode === 'water' ? 1 - clamp(drainProgress, 0, 1) : 0
        } else {
          phase = 'complete'
          progress = 1
          waterOpacity = request.mode === 'water' ? 0 : 1
        }

        this.setPhase(phase)
        if (token !== this.runToken) return
        const revealedCount =
          phase === 'searching'
            ? 0
            : phase === 'found'
              ? 1
              : Math.max(1, Math.ceil(path.length * progress))
        const revealedCells = path.slice(0, revealedCount)

        if (request.mode === 'particle') {
          this.updateParticles({
            now,
            delta,
            phase,
            progress,
            path,
            density,
            color: request.color,
          })
        }

        const frameParticles =
          phase === 'complete'
            ? []
            : this.particles.map(({ x, y, radius, opacity, color }) => ({
                x,
                y,
                radius,
                opacity,
                color,
              }))
        this.onFrame({
          mode: request.mode,
          phase,
          elapsedMs: elapsed,
          solutionProgress: phase === 'found' ? 0 : progress,
          revealedCells,
          waterOpacity,
          particles: frameParticles,
        })
        if (token !== this.runToken) return

        if (phase === 'complete') {
          this.frameId = null
          this.particles = []
          this.pendingResolve = null
          resolve('complete')
          return
        }
        const nextFrame = this.requestFrame(tick)
        if (token !== this.runToken) {
          this.cancelFrame(nextFrame)
          return
        }
        this.frameId = nextFrame
      }
      const firstFrame = this.requestFrame(tick)
      if (token !== this.runToken) {
        this.cancelFrame(firstFrame)
        return
      }
      this.frameId = firstFrame
    })
  }

  cancel(options: { emitComplete?: boolean } = {}): void {
    this.runToken += 1
    if (this.frameId !== null) {
      this.cancelFrame(this.frameId)
      this.frameId = null
    }
    this.particles = []
    const resolve = this.pendingResolve
    this.pendingResolve = null
    resolve?.(this.phase)
    if (options.emitComplete) {
      this.setPhase('complete')
    }
  }

  dispose(): void {
    this.cancel()
  }

  private setPhase(phase: MazeAnimationPhase): void {
    if (phase === this.phase) return
    this.phase = phase
    this.onPhaseChange?.(phase)
  }

  private prefersReducedMotion(): boolean {
    if (this.reducedMotionOverride !== undefined) return this.reducedMotionOverride
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  }

  private updateParticles(input: {
    now: number
    delta: number
    phase: MazeAnimationPhase
    progress: number
    path: ReadonlyArray<MazePoint>
    density: ParticleDensitySettings
    color?: string
  }): void {
    const { now, delta, phase, progress, path, density, color } = input
    const deltaSeconds = delta / 1000
    this.particles = this.particles.filter((particle) => {
      const age = now - particle.bornAt
      if (age >= particle.lifetimeMs) return false
      particle.velocityY += 0.28 * deltaSeconds
      particle.x += particle.velocityX * deltaSeconds
      particle.y += particle.velocityY * deltaSeconds
      particle.opacity = clamp(1 - age / particle.lifetimeMs, 0, 1)
      return true
    })

    if (
      phase !== 'revealing' ||
      now - this.lastParticleAt < density.spawnIntervalMs ||
      this.particles.length >= density.maxParticles
    ) {
      return
    }

    const activeIndex = clamp(Math.floor(progress * (path.length - 1)), 0, path.length - 1)
    const emitter = path[activeIndex]
    const available = density.maxParticles - this.particles.length
    const spawnCount = Math.min(
      available,
      Math.max(1, Math.round(1 + density.overlap * 4)),
    )
    for (let index = 0; index < spawnCount; index += 1) {
      const sequence = this.particleSequence++
      const angle = Math.sin(sequence * 12.9898 + activeIndex * 7.233) * Math.PI
      const speed = 0.12 + ((sequence * 17) % 11) / 50
      this.particles.push({
        x: emitter.col + 0.5 + Math.cos(angle) * density.overlap * 0.08,
        y: emitter.row + 0.5 + Math.sin(angle) * density.overlap * 0.08,
        radius: density.particleSize,
        opacity: 1,
        color,
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed - 0.15,
        bornAt: now,
        lifetimeMs: 500 + ((sequence * 47) % 440),
      })
    }
    this.lastParticleAt = now
  }
}
