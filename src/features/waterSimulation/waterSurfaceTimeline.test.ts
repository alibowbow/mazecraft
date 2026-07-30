import { describe, expect, it } from 'vitest'
import {
  createEmptyGraph,
  openPassage,
  type CellPosition,
  type MazeGraph,
} from '../../core/maze'
import { buildWaterSimulation } from './waterModel'
import {
  buildWaterSurfaceTimeline,
  type WaterSurfaceTimeline,
} from './waterSurfaceTimeline'

type Passage = readonly [CellPosition, CellPosition]

function createGraph(
  rows: number,
  cols: number,
  passages: readonly Passage[],
): MazeGraph {
  const graph = createEmptyGraph(rows, cols, {
    seed: 'water-surface-timeline',
  })
  for (const [from, to] of passages) {
    expect(openPassage(graph, from, to)).toBe(true)
  }
  return graph
}

function texelForCell(
  timeline: WaterSurfaceTimeline,
  graph: MazeGraph,
  row: number,
  col: number,
): { x: number; y: number } {
  const centerOffset = Math.floor(timeline.pixelsPerCell / 2)
  return {
    x: col * timeline.pixelsPerCell + centerOffset,
    y:
      (graph.rows - 1 - row) * timeline.pixelsPerCell +
      centerOffset,
  }
}

function offsetAt(
  timeline: WaterSurfaceTimeline,
  x: number,
  y: number,
): number {
  return (y * timeline.width + x) * 4
}

function maskConnects(
  timeline: WaterSurfaceTimeline,
  start: { x: number; y: number },
  end: { x: number; y: number },
): boolean {
  const startIndex = start.y * timeline.width + start.x
  const endIndex = end.y * timeline.width + end.x
  const visited = new Uint8Array(timeline.width * timeline.height)
  const queue = new Int32Array(timeline.width * timeline.height)
  let queueStart = 0
  let queueEnd = 0
  queue[queueEnd++] = startIndex
  visited[startIndex] = 1

  while (queueStart < queueEnd) {
    const index = queue[queueStart++]
    if (index === endIndex) return true
    const x = index % timeline.width
    const y = Math.floor(index / timeline.width)
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < timeline.width ? index + 1 : -1,
      y > 0 ? index - timeline.width : -1,
      y + 1 < timeline.height ? index + timeline.width : -1,
    ]
    for (const neighbor of neighbors) {
      if (
        neighbor < 0 ||
        visited[neighbor] ||
        timeline.field[neighbor * 4] === 0
      ) {
        continue
      }
      visited[neighbor] = 1
      queue[queueEnd++] = neighbor
    }
  }
  return false
}

describe('buildWaterSurfaceTimeline', () => {
  it('creates one continuous rounded channel from the top inlet to the bottom outlet', () => {
    const graph = createGraph(4, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 2, col: 1 }, { row: 3, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
      [{ row: 2, col: 0 }, { row: 2, col: 1 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 3, col: 1 },
    )
    const timeline = buildWaterSurfaceTimeline(graph, model, {
      pixelsPerCell: 8,
    })
    const source = texelForCell(timeline, graph, 0, 1)
    const exit = texelForCell(timeline, graph, 3, 1)

    expect(
      maskConnects(
        timeline,
        { x: source.x, y: timeline.height - 1 },
        { x: exit.x, y: 0 },
      ),
    ).toBe(true)

    // This loop edge is open but is not part of the earliest-arrival tree.
    const nonTreeEdgeMidpoint = {
      x: Math.round(
        (texelForCell(timeline, graph, 2, 0).x +
          texelForCell(timeline, graph, 2, 1).x) /
          2,
      ),
      y: texelForCell(timeline, graph, 2, 0).y,
    }
    expect(
      timeline.field[
        offsetAt(
          timeline,
          nonTreeEdgeMidpoint.x,
          nonTreeEdgeMidpoint.y,
        )
      ],
    ).toBeGreaterThan(0)
  })

  it('encodes graph-down flow as negative texture Y', () => {
    const graph = createGraph(3, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 0 },
    )
    const timeline = buildWaterSurfaceTimeline(graph, model, {
      pixelsPerCell: 8,
    })
    const top = texelForCell(timeline, graph, 0, 0)
    const middle = texelForCell(timeline, graph, 1, 0)
    const offset = offsetAt(
      timeline,
      top.x,
      Math.round((top.y + middle.y) / 2),
    )

    expect(timeline.field[offset]).toBeGreaterThan(0)
    expect(timeline.field[offset + 1]).toBe(128)
    expect(timeline.field[offset + 2]).toBe(0)
  })

  it('stores the retained water level at a pooled dead end', () => {
    const graph = createGraph(4, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 2, col: 1 }, { row: 3, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 3, col: 1 },
    )
    const timeline = buildWaterSurfaceTimeline(graph, model, {
      pixelsPerCell: 8,
    })
    const deadEnd = texelForCell(timeline, graph, 2, 0)
    const offset = offsetAt(timeline, deadEnd.x, deadEnd.y)

    expect(timeline.field[offset]).toBe(255)
    expect(timeline.schedule[offset + 2]).toBeCloseTo(
      model.options.pooledLevel,
      5,
    )
  })

  it('produces byte-for-byte deterministic atlases', () => {
    const graph = createGraph(3, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 2, col: 1 },
    )

    const first = buildWaterSurfaceTimeline(graph, model)
    const second = buildWaterSurfaceTimeline(graph, model)

    expect(second.width).toBe(first.width)
    expect(second.height).toBe(first.height)
    expect(second.maxTimeMs).toBe(first.maxTimeMs)
    expect(second.schedule).toEqual(first.schedule)
    expect(second.field).toEqual(first.field)
  })

  it('reduces atlas scale to the texture cap without dropping below two pixels per cell', () => {
    const graph = createEmptyGraph(40, 60, {
      seed: 'water-surface-size-cap',
    })
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 0 },
      { row: 39, col: 59 },
    )
    const timeline = buildWaterSurfaceTimeline(graph, model, {
      pixelsPerCell: 24,
      maxTextureSize: 128,
    })

    expect(timeline.pixelsPerCell).toBe(2)
    expect(timeline.width).toBeLessThanOrEqual(128)
    expect(timeline.height).toBeLessThanOrEqual(128)
    expect(timeline.width).toBe(120)
    expect(timeline.height).toBe(80)
  })
})
