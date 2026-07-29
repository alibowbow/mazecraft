import { createEmptyGraph, getActiveCell, openPassage } from '../graph'
import { SeededRandom, normalizeSeed } from '../seed'
import type { MazeGenerationOptions, MazeGraph } from '../types'
import { braidDeadEnds } from './common'

class DisjointSet {
  private readonly parent: Int32Array
  private readonly rank: Uint8Array

  constructor(size: number) {
    this.parent = Int32Array.from({ length: size }, (_, index) => index)
    this.rank = new Uint8Array(size)
  }

  find(value: number): number {
    let root = value
    while (this.parent[root] !== root) root = this.parent[root]
    while (this.parent[value] !== value) {
      const next = this.parent[value]
      this.parent[value] = root
      value = next
    }
    return root
  }

  union(left: number, right: number): boolean {
    let leftRoot = this.find(left)
    let rightRoot = this.find(right)
    if (leftRoot === rightRoot) return false
    if (this.rank[leftRoot] < this.rank[rightRoot]) {
      ;[leftRoot, rightRoot] = [rightRoot, leftRoot]
    }
    this.parent[rightRoot] = leftRoot
    if (this.rank[leftRoot] === this.rank[rightRoot]) this.rank[leftRoot] += 1
    return true
  }
}

export function generateKruskalMaze(options: MazeGenerationOptions): MazeGraph {
  const seed = normalizeSeed(options.seed)
  const random = new SeededRandom(seed, 'kruskal')
  const graph = createEmptyGraph(options.rows, options.cols, {
    mask: options.mask,
    algorithm: 'kruskal',
    seed,
  })
  const edges: Array<readonly [number, number]> = []

  for (const cell of graph.cells) {
    if (!cell.active) continue
    const right = getActiveCell(graph, { row: cell.row, col: cell.col + 1 })
    const bottom = getActiveCell(graph, { row: cell.row + 1, col: cell.col })
    if (right) edges.push([cell.index, right.index])
    if (bottom) edges.push([cell.index, bottom.index])
  }

  const sets = new DisjointSet(graph.cells.length)
  for (const [leftIndex, rightIndex] of random.shuffle(edges)) {
    if (sets.union(leftIndex, rightIndex)) {
      const left = graph.cells[leftIndex]
      const right = graph.cells[rightIndex]
      if (openPassage(graph, left, right)) {
        options.onPassageOpened?.(left, right)
      }
    }
  }

  braidDeadEnds(
    graph,
    random,
    options.braidProbability ?? 0,
    options.onPassageOpened,
  )
  return graph
}
