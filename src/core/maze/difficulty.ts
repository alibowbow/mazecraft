import type {
  DifficultyLevel,
  DifficultyProfile,
  MazeAlgorithm,
  MazeMetrics,
} from './types'

export const DIFFICULTY_PROFILES: Readonly<
  Record<Exclude<DifficultyLevel, 'custom'>, DifficultyProfile>
> = {
  'very-easy': {
    level: 'very-easy',
    targetScore: 15,
    minScore: 0,
    maxScore: 24,
    estimatedSecondsRange: [5, 25],
  },
  easy: {
    level: 'easy',
    targetScore: 34,
    minScore: 25,
    maxScore: 44,
    estimatedSecondsRange: [15, 50],
  },
  normal: {
    level: 'normal',
    targetScore: 55,
    minScore: 45,
    maxScore: 64,
    estimatedSecondsRange: [30, 90],
  },
  hard: {
    level: 'hard',
    targetScore: 75,
    minScore: 65,
    maxScore: 84,
    estimatedSecondsRange: [60, 180],
  },
  expert: {
    level: 'expert',
    targetScore: 92,
    minScore: 85,
    maxScore: 100,
    estimatedSecondsRange: [120, Number.POSITIVE_INFINITY],
  },
}
export interface DifficultySignals {
  activeCells: number
  pathLength: number
  solutionRatio: number
  deadEndRatio: number
  branches: number
  turns: number
  exitDecoys: number
  loopCount: number
  solvable: boolean
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function calculateDifficultyScore(signals: DifficultySignals): number {
  if (!signals.solvable || signals.activeCells <= 1 || signals.pathLength <= 0) return 0

  const size = clamp01(Math.log2(signals.activeCells + 1) / 13)
  const pathScale = clamp01(
    signals.pathLength / Math.max(1, Math.sqrt(signals.activeCells) * 5),
  )
  const pathCoverage = clamp01(signals.solutionRatio / 0.5)
  const deadEnds = clamp01(signals.deadEndRatio / 0.22)
  const branches = clamp01(signals.branches / Math.max(1, signals.activeCells * 0.1))
  const turnDensity = clamp01(
    signals.turns / Math.max(1, signals.pathLength * 0.5),
  )
  const decoys = clamp01(signals.exitDecoys / 8)
  const loops = clamp01(signals.loopCount / Math.max(1, signals.activeCells * 0.04))

  const score =
    size * 7 +
    pathScale * 20 +
    pathCoverage * 19 +
    deadEnds * 15 +
    branches * 12 +
    turnDensity * 14 +
    decoys * 8 +
    loops * 5
  return Math.round(Math.min(100, Math.max(0, score)))
}

export function difficultyFromScore(
  score: number,
): Exclude<DifficultyLevel, 'custom'> {
  if (score < 25) return 'very-easy'
  if (score < 45) return 'easy'
  if (score < 65) return 'normal'
  if (score < 85) return 'hard'
  return 'expert'
}

export function targetScoreForDifficulty(
  difficulty: DifficultyLevel,
  customTargetScore = 55,
): number {
  if (difficulty === 'custom') {
    return Math.round(Math.min(100, Math.max(0, customTargetScore)))
  }
  return DIFFICULTY_PROFILES[difficulty].targetScore
}

export function recommendedAlgorithm(
  difficulty: DifficultyLevel,
): MazeAlgorithm {
  if (difficulty === 'very-easy') return 'prim'
  if (difficulty === 'easy') return 'kruskal'
  if (difficulty === 'hard' || difficulty === 'expert') return 'dfs'
  return 'kruskal'
}

export function recommendedBraidProbability(difficulty: DifficultyLevel): number {
  if (difficulty === 'very-easy') return 0.16
  if (difficulty === 'easy') return 0.08
  if (difficulty === 'normal' || difficulty === 'custom') return 0.025
  return 0
}

export function compareMetricsToDifficulty(
  metrics: MazeMetrics,
  difficulty: DifficultyLevel,
  customTargetScore?: number,
): number {
  const target = targetScoreForDifficulty(difficulty, customTargetScore)
  const disconnectedPenalty = metrics.componentCount > 1 ? 100 : 0
  const unsolvablePenalty = metrics.solvable ? 0 : 200
  const widthPenalty = metrics.minimumPassageWidth < 1 ? 50 : 0
  return (
    Math.abs(metrics.difficultyScore - target) +
    disconnectedPenalty +
    unsolvablePenalty +
    widthPenalty
  )
}
