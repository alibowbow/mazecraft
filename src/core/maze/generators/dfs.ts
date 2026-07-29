import { createEmptyGraph, getActiveNeighbors, openPassage } from '../graph'
import { SeededRandom, normalizeSeed } from '../seed'
import type { MazeGenerationOptions, MazeGraph } from '../types'
import { braidDeadEnds } from './common'

export function generateDfsMaze(options: MazeGenerationOptions): MazeGraph {
  const seed = normalizeSeed(options.seed)
  const random = new SeededRandom(seed, 'dfs')
  const graph = createEmptyGraph(options.rows, options.cols, {
    mask: options.mask,
    algorithm: 'dfs',
    seed,
  })
  const visited = new Uint8Array(graph.cells.length)
  const starts = random.shuffle(graph.cells.filter((cell) => cell.active))

  for (const start of starts) {
    if (visited[start.index]) continue
    visited[start.index] = 1
    const stack = [start]

    while (stack.length > 0) {
      const current = stack[stack.length - 1]
      const candidates = getActiveNeighbors(graph, current).filter(
        ({ cell }) => !visited[cell.index],
      )
      if (candidates.length === 0) {
        stack.pop()
        continue
      }

      const next = random.pick(candidates).cell
      if (openPassage(graph, current, next)) {
        options.onPassageOpened?.(current, next)
      }
      visited[next.index] = 1
      stack.push(next)
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
