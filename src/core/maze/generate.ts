import {
  compareMetricsToDifficulty,
  recommendedAlgorithm,
  recommendedBraidProbability,
} from './difficulty'
import { optimizeEndpoints } from './endpoints'
import {
  generateDfsMaze,
  generateKruskalMaze,
  generatePrimMaze,
} from './generators'
import { calculateMazeMetrics } from './metrics'
import { deriveSeed } from './seed'
import type {
  MazeCandidate,
  MazeCandidateProgress,
  MazeCandidateRequest,
  MazeGenerationOptions,
  MazeGenerationResult,
  MazeGraph,
} from './types'

export interface CandidateGenerationHooks {
  onProgress?: (progress: MazeCandidateProgress) => void
  isCancelled?: () => boolean
}

export function generateMazeGraph(options: MazeGenerationOptions): MazeGraph {
  const algorithm = options.algorithm ?? 'dfs'
  if (algorithm === 'kruskal') return generateKruskalMaze(options)
  if (algorithm === 'prim') return generatePrimMaze(options)
  return generateDfsMaze(options)
}

export function generateMaze(options: MazeGenerationOptions): MazeGenerationResult {
  const graph = generateMazeGraph(options)
  const endpoints = optimizeEndpoints(graph)
  const metrics = calculateMazeMetrics(graph, endpoints.start, endpoints.end)
  return {
    graph,
    start: endpoints.start,
    end: endpoints.end,
    metrics,
  }
}

export function candidateCountForSize(rows: number, cols: number): number {
  const largestDimension = Math.max(rows, cols)
  if (largestDimension <= 70) return 12
  if (largestDimension <= 100) return 6
  return 3
}

export function generateMazeCandidateAtIndex(
  request: MazeCandidateRequest,
  candidateIndex: number,
): MazeCandidate {
  if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
    throw new RangeError('Candidate index must be a non-negative integer.')
  }
  const algorithm = request.algorithm ?? recommendedAlgorithm(request.difficulty)
  const braidProbability =
    request.braidProbability ?? recommendedBraidProbability(request.difficulty)
  const seed = deriveSeed(request.seed, algorithm, candidateIndex)
  const generationTrace: MazeCandidate['generationTrace'] = []
  const graph = generateMazeGraph({
    ...request,
    algorithm,
    braidProbability,
    seed,
    onPassageOpened: (from, to) => {
      generationTrace.push({
        from: { row: from.row, col: from.col },
        to: { row: to.row, col: to.col },
      })
    },
  })
  const endpoints = optimizeEndpoints(graph)
  const metrics = calculateMazeMetrics(graph, endpoints.start, endpoints.end, {
    shapeRecognition: request.shapeRecognition,
    minimumPassageWidth: request.minimumPassageWidth,
  })
  const targetDistance = compareMetricsToDifficulty(
    metrics,
    request.difficulty,
    request.customTargetScore,
  )
  return {
    candidateIndex,
    targetDistance,
    generationTrace,
    result: {
      graph,
      start: endpoints.start,
      end: endpoints.end,
      metrics,
    },
  }
}

export function generateMazeCandidates(
  request: MazeCandidateRequest,
  hooks: CandidateGenerationHooks = {},
): MazeCandidate[] {
  const total = Math.max(
    1,
    Math.min(24, request.candidateCount ?? candidateCountForSize(request.rows, request.cols)),
  )
  const candidates: MazeCandidate[] = []
  let bestScore: number | undefined

  for (let candidateIndex = 0; candidateIndex < total; candidateIndex += 1) {
    if (hooks.isCancelled?.()) break
    const candidate = generateMazeCandidateAtIndex(request, candidateIndex)
    candidates.push(candidate)
    bestScore =
      bestScore === undefined
        ? candidate.targetDistance
        : Math.min(bestScore, candidate.targetDistance)
    hooks.onProgress?.({
      completed: candidateIndex + 1,
      total,
      bestScore,
    })
  }

  return candidates.sort(
    (left, right) =>
      left.targetDistance - right.targetDistance ||
      left.candidateIndex - right.candidateIndex,
  )
}

export function generateBestMazeCandidate(
  request: MazeCandidateRequest,
  hooks: CandidateGenerationHooks = {},
): MazeCandidate {
  const best = generateMazeCandidates(request, hooks)[0]
  if (!best) {
    throw new DOMException('Maze generation was cancelled.', 'AbortError')
  }
  return best
}
