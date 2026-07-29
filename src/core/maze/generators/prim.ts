import { createEmptyGraph, getActiveNeighbors, openPassage } from '../graph'
import { SeededRandom, normalizeSeed } from '../seed'
import type { MazeCell, MazeGenerationOptions, MazeGraph } from '../types'
import { braidDeadEnds } from './common'

interface FrontierEdge {
  from: MazeCell
  to: MazeCell
}

export function generatePrimMaze(options: MazeGenerationOptions): MazeGraph {
  const seed = normalizeSeed(options.seed)
  const random = new SeededRandom(seed, 'prim')
  const graph = createEmptyGraph(options.rows, options.cols, {
    mask: options.mask,
    algorithm: 'prim',
    seed,
  })
  const visited = new Uint8Array(graph.cells.length)
  const starts = random.shuffle(graph.cells.filter((cell) => cell.active))

  const addFrontier = (cell: MazeCell, frontier: FrontierEdge[]): void => {
    for (const { cell: neighbor } of getActiveNeighbors(graph, cell)) {
      if (!visited[neighbor.index]) frontier.push({ from: cell, to: neighbor })
    }
  }

  for (const start of starts) {
    if (visited[start.index]) continue
    visited[start.index] = 1
    const frontier: FrontierEdge[] = []
    addFrontier(start, frontier)

    while (frontier.length > 0) {
      const chosenIndex = random.integer(0, frontier.length)
      const edge = frontier[chosenIndex]
      frontier[chosenIndex] = frontier[frontier.length - 1]
      frontier.pop()
      if (visited[edge.to.index]) continue

      if (openPassage(graph, edge.from, edge.to)) {
        options.onPassageOpened?.(edge.from, edge.to)
      }
      visited[edge.to.index] = 1
      addFrontier(edge.to, frontier)
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
