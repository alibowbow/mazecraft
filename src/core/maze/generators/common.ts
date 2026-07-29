import {
  getActiveNeighbors,
  getCellDegree,
  openPassage,
} from '../graph'
import type { MazeGraph } from '../types'
import type { MazeGenerationOptions } from '../types'
import type { SeededRandom } from '../seed'

export function braidDeadEnds(
  graph: MazeGraph,
  random: SeededRandom,
  probability: number,
  onPassageOpened?: MazeGenerationOptions['onPassageOpened'],
): void {
  if (probability <= 0) return

  const deadEnds = random.shuffle(
    graph.cells.filter((cell) => cell.active && getCellDegree(graph, cell) === 1),
  )
  for (const cell of deadEnds) {
    if (!random.boolean(probability)) continue
    const closedNeighbors = getActiveNeighbors(graph, cell).filter(
      ({ direction }) => cell.walls[direction],
    )
    if (closedNeighbors.length === 0) continue

    const preferred = closedNeighbors
      .map((neighbor) => ({
        ...neighbor,
        degree: getCellDegree(graph, neighbor.cell),
      }))
      .sort((left, right) => left.degree - right.degree)
    const minimumDegree = preferred[0].degree
    const choices = preferred.filter((neighbor) => neighbor.degree === minimumDegree)
    const next = random.pick(choices).cell
    if (openPassage(graph, cell, next)) onPassageOpened?.(cell, next)
  }
}
