import { describe, expect, it } from 'vitest'
import { createEmptyGraph, openPassage } from '../../../core/maze'
import {
  buildWaterTopologyAtlas,
  countClosedWallLeakTexels,
  createDynamicStateTextureBuffer,
  createWaterDetailTextureData,
  createWaterSurfaceProfile,
  EdgeVelocityAggregator,
  resolveFiniteDepthPhaseScale,
  resetDynamicStateTexture,
  updateDynamicStateTexture,
  WaterFoamHistory,
} from './index'

function atlasOffset(
  width: number,
  pixelsPerCell: number,
  rows: number,
  row: number,
  col: number,
  localX: number,
  localY: number,
): number {
  const x = col * pixelsPerCell + localX
  const y = (rows - 1 - row) * pixelsPerCell + localY
  return (y * width + x) * 4
}

describe('static water topology atlas', () => {
  it('covers open portals but never paints across a closed wall', () => {
    const graph = createEmptyGraph(2, 2, { seed: 'atlas-walls' })
    expect(openPassage(graph, { row: 0, col: 0 }, { row: 1, col: 0 })).toBe(true)
    const atlas = buildWaterTopologyAtlas(graph, { pixelsPerCell: 8 })
    const middle = 4

    const openPortal = atlasOffset(
      atlas.width,
      atlas.pixelsPerCell,
      graph.rows,
      0,
      0,
      middle,
      0,
    )
    const closedPortal = atlasOffset(
      atlas.width,
      atlas.pixelsPerCell,
      graph.rows,
      0,
      0,
      atlas.pixelsPerCell - 1,
      middle,
    )
    const oppositeClosedPortal = atlasOffset(
      atlas.width,
      atlas.pixelsPerCell,
      graph.rows,
      0,
      1,
      0,
      middle,
    )
    expect(atlas.data[openPortal]).toBe(255)
    expect(atlas.data[closedPortal]).toBe(0)
    expect(atlas.data[oppositeClosedPortal]).toBe(0)
    expect(countClosedWallLeakTexels(graph, atlas)).toBe(0)
  })

  it('reports deterministic mask coverage on closed and inactive portals', () => {
    const graph = createEmptyGraph(1, 3, {
      seed: 'atlas-leak-diagnostic',
      mask: [true, true, false],
    })
    expect(openPassage(graph, { row: 0, col: 0 }, { row: 0, col: 1 })).toBe(true)
    const atlas = buildWaterTopologyAtlas(graph, { pixelsPerCell: 6 })
    expect(countClosedWallLeakTexels(graph, atlas)).toBe(0)

    const activeSide = atlasOffset(
      atlas.width,
      atlas.pixelsPerCell,
      graph.rows,
      0,
      1,
      atlas.pixelsPerCell - 1,
      3,
    )
    const inactiveSide = atlasOffset(
      atlas.width,
      atlas.pixelsPerCell,
      graph.rows,
      0,
      2,
      0,
      3,
    )
    atlas.data[activeSide] = 255
    expect(countClosedWallLeakTexels(graph, atlas)).toBe(1)
    atlas.data[inactiveSide] = 255
    expect(countClosedWallLeakTexels(graph, atlas)).toBe(2)
  })

  it('uses the solver node ordering and rejects incomplete permutations', () => {
    const graph = createEmptyGraph(1, 3, { seed: 'atlas-order' })
    const atlas = buildWaterTopologyAtlas(graph, {
      pixelsPerCell: 4,
      nodeCellIndices: new Int32Array([2, 0, 1]),
    })
    expect([...atlas.activeCellIndices]).toEqual([2, 0, 1])
    expect([...atlas.cellToActiveIndex]).toEqual([1, 2, 0])
    expect(() =>
      buildWaterTopologyAtlas(graph, {
        nodeCellIndices: new Int32Array([0, 1]),
      }),
    ).toThrow(/every active cell/)
  })
})

describe('packed dynamic state texture', () => {
  it('maps solver nodes into flipped WebGL rows, reuses storage and resets', () => {
    const buffer = createDynamicStateTextureBuffer(
      2,
      2,
      new Int32Array([3, 0]),
      { depthScale: 2, velocityScale: 4 },
    )
    const storage = buffer.data
    updateDynamicStateTexture(buffer, {
      simulationTime: 1.25,
      depth: new Float64Array([1, 0.5]),
      velocityX: new Float32Array([-2, 8]),
      velocityY: new Float32Array([1, -8]),
      foamSource: new Float32Array([0.25, 2]),
    })

    expect(buffer.data).toBe(storage)
    expect(buffer.nodeToTexelOffset[0]).toBe((0 * 2 + 1) * 4)
    expect(buffer.nodeToTexelOffset[1]).toBe((1 * 2 + 0) * 4)
    expect([...buffer.data.slice(buffer.nodeToTexelOffset[0], buffer.nodeToTexelOffset[0] + 4)])
      .toEqual([0.5, -0.5, 0.25, 0.25])
    expect([...buffer.data.slice(buffer.nodeToTexelOffset[1], buffer.nodeToTexelOffset[1] + 4)])
      .toEqual([0.25, 1, -1, 1])
    expect(buffer.stats.maximumVelocity).toBeCloseTo(Math.hypot(8, -8))
    expect(buffer.stats.wetCellCount).toBe(2)

    resetDynamicStateTexture(buffer)
    expect(buffer.data.every((value) => value === 0)).toBe(true)
    expect(buffer.stats.simulationTime).toBe(0)
  })
})

describe('edge velocity aggregation', () => {
  it('respects signed discharge, solver node order and inverted render Y', () => {
    // Solver nodes are deliberately not row-major: bottom, top, right.
    const aggregator = new EdgeVelocityAggregator({
      cols: 2,
      nodeCellIndex: new Int32Array([2, 0, 1]),
      edgeFrom: new Int32Array([1, 1]),
      edgeTo: new Int32Array([0, 2]),
    }).update(
      new Float64Array([2, -1]),
      new Float64Array([4, -3]),
    )

    // Edge top -> bottom: maze row grows down, rendering Y therefore is -1.
    expect(aggregator.velocityX[0]).toBeCloseTo(0)
    expect(aggregator.velocityY[0]).toBeCloseTo(-4)
    // Negative Q reverses the top -> right edge, making flow point left.
    expect(aggregator.velocityX[2]).toBeCloseTo(-3)
    expect(aggregator.velocityY[2]).toBeCloseTo(0)
    expect(aggregator.convergence[0]).toBeCloseTo(2)
    expect(aggregator.convergence[2]).toBeCloseTo(-1)
  })
})

describe('foam history and deterministic surface assets', () => {
  it('builds, decays, pauses exactly and resets both history buffers', () => {
    const history = new WaterFoamHistory(2, 1, {
      buildRate: 3,
      decayRate: 1,
    })
    history.step(new Float32Array([1, 0]), 0.25)
    const built = history.data[0]
    expect(built).toBeGreaterThan(0)
    expect(history.data[1]).toBe(0)
    const pausedData = history.data
    const pausedVersion = history.version
    expect(history.step(new Float32Array([0, 1]), 0.25, true)).toBe(pausedData)
    expect(history.version).toBe(pausedVersion)

    history.step(new Float32Array([0, 0]), 0.25)
    expect(history.data[0]).toBeLessThan(built)
    history.reset()
    expect(history.data.every((value) => value === 0)).toBe(true)
  })

  it('generates repeatable detail and bounded flow-coupled surface profiles', () => {
    const first = createWaterDetailTextureData({ size: 16, seed: 'same' })
    const second = createWaterDetailTextureData({ size: 16, seed: 'same' })
    const different = createWaterDetailTextureData({ size: 16, seed: 'different' })
    expect(first.data).toEqual(second.data)
    expect(first.data).not.toEqual(different.data)
    expect(first.encoding).toBe('normal-rg-structure-ba')
    expect(first.data.some((value, index) => index % 4 !== 3 && value !== first.data[0])).toBe(true)
    for (const channel of [0, 1, 2, 3]) {
      const values = first.data.filter((_, index) => index % 4 === channel)
      expect(new Set(values).size).toBeGreaterThan(4)
    }

    const low = createWaterSurfaceProfile('natural', 'low', 'surface')
    const high = createWaterSurfaceProfile('natural', 'high', 'surface')
    const repeated = createWaterSurfaceProfile('natural', 'high', 'surface')
    const differentSeed = createWaterSurfaceProfile(
      'natural',
      'high',
      'different-surface',
    )
    const dynamic = createWaterSurfaceProfile('dynamic', 'high', 'surface')
    expect(low.waveBands).toHaveLength(2)
    expect(high.waveBands).toHaveLength(3)
    expect(low.foamMode).toBe('procedural')
    expect(high.foamMode).toBe('history')
    expect(repeated).toEqual(high)
    expect(low.waveBands).toEqual(high.waveBands.slice(0, low.waveBands.length))
    expect(differentSeed.waveBands).not.toEqual(high.waveBands)
    expect(dynamic.waveBands).not.toEqual(high.waveBands)
    expect(new Set(high.waveBands.map((band) => band.crossFlow))).toHaveLength(
      high.waveBands.length,
    )
    expect(new Set(high.waveBands.map((band) => band.phase))).toHaveLength(
      high.waveBands.length,
    )

    for (const style of ['calm', 'natural', 'dynamic'] as const) {
      const boundedLow = createWaterSurfaceProfile(style, 'low', 'bounded')
      const boundedHigh = createWaterSurfaceProfile(style, 'high', 'bounded')
      expect(boundedLow.waveBands).toEqual(
        boundedHigh.waveBands.slice(0, boundedLow.waveBands.length),
      )
      expect(boundedLow.subsurfaceStrength).toBe(
        boundedHigh.subsurfaceStrength,
      )
      expect(boundedLow.reflectionStrength).toBe(
        boundedHigh.reflectionStrength,
      )
      expect(
        new Set(boundedHigh.waveBands.map((band) => band.crossFlow)),
      ).toHaveLength(boundedHigh.waveBands.length)
      expect(
        new Set(boundedHigh.waveBands.map((band) => band.phase)),
      ).toHaveLength(boundedHigh.waveBands.length)

      for (const profile of [boundedLow, boundedHigh]) {
        expect(Number.isFinite(profile.subsurfaceStrength)).toBe(true)
        expect(profile.subsurfaceStrength).toBeGreaterThanOrEqual(0)
        expect(profile.subsurfaceStrength).toBeLessThanOrEqual(1)
        expect(Number.isFinite(profile.reflectionStrength)).toBe(true)
        expect(profile.reflectionStrength).toBeGreaterThanOrEqual(0)
        expect(profile.reflectionStrength).toBeLessThanOrEqual(1)
        profile.waveBands.forEach((band) => {
          expect(Number.isFinite(band.crossFlow)).toBe(true)
          expect(Math.abs(band.crossFlow)).toBeLessThanOrEqual(0.4)
          expect(Number.isFinite(band.phase)).toBe(true)
          expect(band.phase).toBeGreaterThanOrEqual(0)
          expect(band.phase).toBeLessThan(Math.PI * 2)
        })
      }
    }

    expect(dynamic.subsurfaceStrength).toBeGreaterThan(
      high.subsurfaceStrength,
    )
    expect(dynamic.reflectionStrength).toBeLessThan(high.reflectionStrength)
    expect(() =>
      createWaterSurfaceProfile('natural', 'high', Number.NaN),
    ).toThrow(/seed must be finite/)
  })

  it('slows each visual wave band continuously in shallower water', () => {
    const dry = resolveFiniteDepthPhaseScale(4.8, 0)
    const shallow = resolveFiniteDepthPhaseScale(4.8, 0.02)
    const channelDepth = resolveFiniteDepthPhaseScale(4.8, 0.18)
    const deep = resolveFiniteDepthPhaseScale(4.8, 20)
    expect(dry).toBe(0)
    expect(shallow).toBeGreaterThan(dry)
    expect(channelDepth).toBeGreaterThan(shallow)
    expect(deep).toBeGreaterThan(channelDepth)
    expect(deep).toBeCloseTo(1, 8)
    expect(resolveFiniteDepthPhaseScale(0.54, 0.18)).toBeGreaterThan(
      channelDepth,
    )
    expect(() => resolveFiniteDepthPhaseScale(0, 0.1)).toThrow(
      /positive finite/,
    )
    expect(() => resolveFiniteDepthPhaseScale(1, -0.1)).toThrow(
      /non-negative finite/,
    )
  })
})
