import { describe, expect, it, vi } from 'vitest'
import {
  MazeAnimationController,
  resolveParticleDensity,
  type MazeAnimationPhase,
  type MazeAnimationSnapshot,
} from './animationController'

describe('MazeAnimationController', () => {
  it('keeps water transitions ordered through found and revealing before draining', async () => {
    let now = 0
    let nextId = 1
    const callbacks = new Map<number, FrameRequestCallback>()
    const phases: MazeAnimationPhase[] = []
    const snapshots: MazeAnimationSnapshot[] = []
    const controller = new MazeAnimationController({
      onFrame: (snapshot) => snapshots.push(snapshot),
      onPhaseChange: (phase) => phases.push(phase),
      reducedMotion: false,
      now: () => now,
      requestFrame: (callback) => {
        const id = nextId++
        callbacks.set(id, callback)
        return id
      },
      cancelFrame: (id) => callbacks.delete(id),
    })
    const completion = controller.play({
      mode: 'water',
      path: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 1 },
      ],
      revealDurationMs: 220,
    })

    const advance = (time: number): void => {
      now = time
      const [entry] = callbacks.entries()
      expect(entry).toBeTruthy()
      callbacks.delete(entry[0])
      entry[1](time)
    }
    advance(100)
    advance(300)
    advance(450)
    advance(700)
    advance(1_180)
    await expect(completion).resolves.toBe('complete')

    expect(phases).toEqual(
      expect.arrayContaining(['searching', 'found', 'revealing', 'draining', 'complete']),
    )
    expect(phases.indexOf('found')).toBeLessThan(phases.indexOf('revealing'))
    expect(phases.indexOf('revealing')).toBeLessThan(phases.indexOf('draining'))
    expect(snapshots.at(-1)?.solutionProgress).toBe(1)
  })

  it('connects density to size, interval, maximum count, and overlap', () => {
    const low = resolveParticleDensity(1)
    const high = resolveParticleDensity(10)
    expect(high.particleSize).toBeGreaterThan(low.particleSize)
    expect(high.spawnIntervalMs).toBeLessThan(low.spawnIntervalMs)
    expect(high.maxParticles).toBeGreaterThan(low.maxParticles)
    expect(high.overlap).toBeGreaterThan(low.overlap)
  })

  it('cancels the managed animation frame when disposed', () => {
    const cancelFrame = vi.fn()
    const controller = new MazeAnimationController({
      onFrame: vi.fn(),
      reducedMotion: false,
      requestFrame: () => 73,
      cancelFrame,
    })
    void controller.play({
      mode: 'path',
      path: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
      ],
    })
    controller.dispose()
    expect(cancelFrame).toHaveBeenCalledWith(73)
    expect(controller.isRunning()).toBe(false)
  })

  it('does not let a reentrant frame callback clobber a newly started run', async () => {
    let now = 0
    let nextId = 1
    let restarted = false
    const callbacks = new Map<number, FrameRequestCallback>()
    let controller: MazeAnimationController
    controller = new MazeAnimationController({
      reducedMotion: false,
      now: () => now,
      requestFrame: (callback) => {
        const id = nextId++
        callbacks.set(id, callback)
        return id
      },
      cancelFrame: (id) => callbacks.delete(id),
      onFrame: () => {
        if (restarted) return
        restarted = true
        void controller.play({
          mode: 'path',
          path: [
            { row: 1, col: 0 },
            { row: 1, col: 1 },
          ],
        })
      },
    })

    const oldRun = controller.play({
      mode: 'water',
      path: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
      ],
    })
    now = 100
    const [oldFrame] = callbacks.entries()
    callbacks.delete(oldFrame[0])
    oldFrame[1](now)

    await expect(oldRun).resolves.toBe('searching')
    expect(controller.isRunning()).toBe(true)
    expect(callbacks).toHaveLength(1)
  })
})
