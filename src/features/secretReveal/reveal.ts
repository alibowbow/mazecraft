import type { CellPosition, MazeProject } from '../../core/maze/types'
import { positionKey } from '../player/playerEngine'

export const safeSecretLink = (value: string): string | null => {
  if (!value || value.length > 4096) return null
  try {
    const parsed = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

export const revealProgress = (
  project: MazeProject,
  visited: string[],
  solutionPath: CellPosition[],
  reachedCheckpoints: number,
  completed: boolean,
) => {
  const mode = project.secretReveal.mode
  if (mode === 'on-complete') return completed ? 1 : 0
  if (mode === 'checkpoints') {
    const count = project.checkpoints.length
    return count === 0 ? (completed ? 1 : 0) : Math.min(1, reachedCheckpoints / count)
  }
  if (mode === 'solution-path') {
    const visitedSet = new Set(visited)
    const revealed = solutionPath.filter((cell) => visitedSet.has(positionKey(cell))).length
    return solutionPath.length ? Math.min(1, revealed / solutionPath.length) : 0
  }
  return project.mazeMetrics.activeCells
    ? Math.min(1, visited.length / project.mazeMetrics.activeCells)
    : 0
}

export const secretText = (project: MazeProject) => {
  const content = project.secretReveal.content
  switch (content.kind) {
    case 'message':
      return content.message
    case 'image-message':
      return content.message
    case 'coupon':
      return `${content.message}\n${content.code}`
    case 'hint':
      return `${content.message}\n다음 장소: ${content.nextLocation}`
    case 'link':
      return content.label
    case 'image':
    case 'none':
      return ''
  }
}
