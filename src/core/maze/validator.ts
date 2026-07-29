import { optimizeEndpoints } from './endpoints'
import {
  cloneMazeGraph,
  getActiveCell,
  getActiveNeighbors,
  getCellDegree,
  getCellIndex,
  getNeighborPosition,
  isPositionInside,
  normalizeWallSymmetry,
  openPassage,
  OPPOSITE_DIRECTION,
  WALL_DIRECTIONS,
} from './graph'
import {
  calculateMazeMetrics,
  createEmptyMazeMetrics,
  type MazeMetricOptions,
} from './metrics'
import { findConnectedComponents, solveMaze } from './solver'
import type {
  CellPosition,
  MazeGraph,
  MazeRepairResult,
  MazeValidationResult,
  ValidationIssue,
  ValidationIssueCode,
} from './types'

export interface MazeValidationOptions extends MazeMetricOptions {
  minimumActiveCells?: number
  minimumPathLength?: number
  minimumSolutionRatio?: number
}
function issue(
  code: ValidationIssueCode,
  severity: ValidationIssue['severity'],
  message: string,
  cells: CellPosition[] = [],
  autoFixable = false,
): ValidationIssue {
  return { code, severity, message, cells, autoFixable }
}

export function validateMaze(
  graph: MazeGraph,
  start: CellPosition,
  end: CellPosition,
  options: MazeValidationOptions = {},
): MazeValidationResult {
  const issues: ValidationIssue[] = []
  const dimensionsValid =
    Number.isInteger(graph.rows) &&
    Number.isInteger(graph.cols) &&
    graph.rows > 0 &&
    graph.cols > 0
  if (!dimensionsValid) {
    issues.push(
      issue(
        'invalid-dimensions',
        'error',
        '미로의 행과 열 크기가 올바르지 않습니다.',
      ),
    )
  }

  const expectedCellCount = dimensionsValid ? graph.rows * graph.cols : 0
  if (graph.cells.length !== expectedCellCount) {
    issues.push(
      issue(
        'invalid-cell-count',
        'error',
        '미로 셀 데이터 수가 격자 크기와 일치하지 않습니다.',
      ),
    )
  }

  if (!dimensionsValid || graph.cells.length !== expectedCellCount) {
    return {
      valid: false,
      solvable: false,
      issues,
      metrics: createEmptyMazeMetrics(),
    }
  }

  for (let index = 0; index < graph.cells.length; index += 1) {
    const cell = graph.cells[index]
    const expectedRow = Math.floor(index / graph.cols)
    const expectedCol = index % graph.cols
    if (
      cell.index !== index ||
      cell.row !== expectedRow ||
      cell.col !== expectedCol
    ) {
      issues.push(
        issue(
          'invalid-cell-index',
          'error',
          '셀 인덱스 또는 좌표가 행 우선 순서와 일치하지 않습니다.',
          [{ row: expectedRow, col: expectedCol }],
        ),
      )
      break
    }
  }

  const asymmetricCells: CellPosition[] = []
  const openOuterCells: CellPosition[] = []
  const isolatedCells: CellPosition[] = []
  for (const cell of graph.cells) {
    if (!cell.active) continue
    if (getCellDegree(graph, cell) === 0 && graph.cells.some((item) => item.active && item.index !== cell.index)) {
      isolatedCells.push({ row: cell.row, col: cell.col })
    }

    for (const direction of WALL_DIRECTIONS) {
      const neighbor = getActiveCell(graph, getNeighborPosition(cell, direction))
      if (!neighbor) {
        if (!cell.walls[direction]) openOuterCells.push(cell)
      } else if (
        cell.walls[direction] !== neighbor.walls[OPPOSITE_DIRECTION[direction]]
      ) {
        asymmetricCells.push(cell)
      }
    }
  }

  if (asymmetricCells.length > 0) {
    issues.push(
      issue(
        'wall-asymmetry',
        'error',
        '인접 셀의 벽 정보가 서로 일치하지 않습니다.',
        asymmetricCells.slice(0, 20),
        true,
      ),
    )
  }
  if (openOuterCells.length > 0) {
    issues.push(
      issue(
        'open-outer-wall',
        'error',
        '격자 또는 형태 바깥으로 열린 벽이 있습니다.',
        openOuterCells.slice(0, 20),
        true,
      ),
    )
  }
  if (isolatedCells.length > 0) {
    issues.push(
      issue(
        'isolated-cell',
        'error',
        '어느 통로와도 연결되지 않은 셀이 있습니다.',
        isolatedCells.slice(0, 20),
        true,
      ),
    )
  }

  const components = findConnectedComponents(graph)
  if (components.length > 1) {
    issues.push(
      issue(
        'disconnected-regions',
        'error',
        `${components.length}개의 끊어진 미로 영역이 발견되었습니다.`,
        components.slice(1).flatMap((component) => component.slice(0, 3)),
        true,
      ),
    )
  }

  const startActive =
    isPositionInside(graph.rows, graph.cols, start) &&
    Boolean(getActiveCell(graph, start))
  const endActive =
    isPositionInside(graph.rows, graph.cols, end) && Boolean(getActiveCell(graph, end))
  if (!startActive) {
    issues.push(
      issue(
        'inactive-start',
        'error',
        '시작점이 유효한 미로 셀에 있지 않습니다.',
        [start],
        true,
      ),
    )
  }
  if (!endActive) {
    issues.push(
      issue(
        'inactive-end',
        'error',
        '종료점이 유효한 미로 셀에 있지 않습니다.',
        [end],
        true,
      ),
    )
  }

  const metrics =
    startActive && endActive
      ? calculateMazeMetrics(graph, start, end, options)
      : createEmptyMazeMetrics()
  if (startActive && endActive && !metrics.solvable) {
    issues.push(
      issue(
        'unreachable-end',
        'error',
        '시작점에서 종료점까지 도달할 수 없습니다.',
        [start, end],
        true,
      ),
    )
  }

  const minimumActiveCells = options.minimumActiveCells ?? 4
  if (graph.cells.filter((cell) => cell.active).length < minimumActiveCells) {
    issues.push(
      issue(
        'too-few-active-cells',
        'error',
        '형태 안의 유효 셀이 너무 적어 미로를 만들기 어렵습니다.',
      ),
    )
  }

  const minimumPathLength =
    options.minimumPathLength ??
    Math.max(3, Math.floor(Math.sqrt(Math.max(1, metrics.activeCells))))
  if (metrics.solvable && metrics.pathLength < minimumPathLength) {
    issues.push(
      issue(
        'short-solution',
        'warning',
        '정답 경로가 선택한 격자 크기에 비해 너무 짧습니다.',
        [start, end],
        true,
      ),
    )
  }

  const minimumSolutionRatio = options.minimumSolutionRatio ?? 0.05
  if (
    metrics.solvable &&
    metrics.activeCells > 10 &&
    metrics.solutionRatio < minimumSolutionRatio
  ) {
    issues.push(
      issue(
        'endpoints-too-close',
        'warning',
        '시작점과 종료점의 실제 그래프 거리가 지나치게 가깝습니다.',
        [start, end],
        true,
      ),
    )
  }
  if (
    options.minimumPassageWidth !== undefined &&
    options.minimumPassageWidth < 1
  ) {
    issues.push(
      issue(
        'narrow-passage',
        'warning',
        '일부 통로가 모바일에서 조작하기에 너무 좁습니다.',
      ),
    )
  }

  const hasError = issues.some((item) => item.severity === 'error')
  return {
    valid: !hasError,
    solvable: metrics.solvable,
    issues,
    metrics,
  }
}

function connectAdjacentRegions(graph: MazeGraph): boolean {
  let changed = false
  let components = findConnectedComponents(graph)

  while (components.length > 1) {
    const labels = new Int32Array(graph.cells.length)
    labels.fill(-1)
    components.forEach((component, componentIndex) => {
      for (const position of component) {
        labels[getCellIndex(graph.cols, position)] = componentIndex
      }
    })

    let bridge:
      | {
          from: CellPosition
          to: CellPosition
        }
      | undefined
    for (const cell of graph.cells) {
      if (!cell.active) continue
      for (const { cell: neighbor } of getActiveNeighbors(graph, cell)) {
        if (labels[cell.index] !== labels[neighbor.index]) {
          bridge = { from: cell, to: neighbor }
          break
        }
      }
      if (bridge) break
    }
    if (!bridge) break
    openPassage(graph, bridge.from, bridge.to)
    changed = true
    components = findConnectedComponents(graph)
  }

  return changed
}

export function repairMaze(
  source: MazeGraph,
  start: CellPosition,
  end: CellPosition,
  options: MazeValidationOptions = {},
): MazeRepairResult {
  const graph = cloneMazeGraph(source)
  const repairs: ValidationIssueCode[] = []
  if (normalizeWallSymmetry(graph) > 0) {
    repairs.push('wall-asymmetry', 'open-outer-wall')
  }
  if (connectAdjacentRegions(graph)) {
    repairs.push('isolated-cell', 'disconnected-regions')
  }

  let repairedStart = start
  let repairedEnd = end
  const initialSolution =
    getActiveCell(graph, start) && getActiveCell(graph, end)
      ? solveMaze(graph, start, end)
      : undefined
  const minimumPathLength =
    options.minimumPathLength ??
    Math.max(3, Math.floor(Math.sqrt(graph.cells.filter((cell) => cell.active).length)))
  if (!initialSolution?.solved || initialSolution.path.length < minimumPathLength) {
    const activeCount = graph.cells.filter((cell) => cell.active).length
    if (activeCount > 0) {
      const endpoints = optimizeEndpoints(graph)
      repairedStart = endpoints.start
      repairedEnd = endpoints.end
      repairs.push(
        !getActiveCell(graph, start) ? 'inactive-start' : 'unreachable-end',
        !getActiveCell(graph, end) ? 'inactive-end' : 'short-solution',
      )
    }
  }

  return {
    graph,
    start: repairedStart,
    end: repairedEnd,
    validation: validateMaze(graph, repairedStart, repairedEnd, options),
    repairs: [...new Set(repairs)],
  }
}
