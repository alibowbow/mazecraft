import {
  createDefaultProject,
  createEmptyGraph,
  createSeededRandom,
  graphToMask,
  normalizeSeed,
  openPassage,
  type MazeGraph,
  type MazeProject,
} from '../../core/maze'

export type WaterStudioPresetId = 'cascade' | 'split' | 'serpentine' | 'garden'

export interface WaterStudioSize {
  rows: number
  cols: number
}

export interface WaterStudioPreset extends WaterStudioSize {
  id: WaterStudioPresetId
  name: string
  caption: string
}

export const WATER_STUDIO_PRESETS: readonly WaterStudioPreset[] = [
  { id: 'cascade', name: '캐스케이드', caption: '넓은 수조 사이로 이어지는 낙수', rows: 8, cols: 6 },
  { id: 'split', name: '트윈 플로우', caption: '둘로 갈라져 다시 만나는 흐름', rows: 8, cols: 8 },
  { id: 'serpentine', name: '리본', caption: '좌우를 가로지르는 긴 물길', rows: 8, cols: 6 },
  { id: 'garden', name: '워터 가든', caption: '작은 섬을 감싸는 열린 수조', rows: 8, cols: 8 },
]

function validateSize({ rows, cols }: WaterStudioSize): void {
  if (![rows, cols].every(value => Number.isInteger(value) && value >= 4 && value <= 24)) {
    throw new RangeError('Water studio dimensions must be integers between 4 and 24.')
  }
}

function horizontalLane(graph: MazeGraph, row: number, from = 0, to = graph.cols - 1): void {
  for (let col = from; col < to; col++) {
    openPassage(graph, { row, col }, { row, col: col + 1 })
  }
}

function fall(graph: MazeGraph, row: number, col: number): void {
  openPassage(graph, { row, col }, { row: row + 1, col })
}

function projectFor(graph: MazeGraph, title: string, startCol: number, endCol: number): MazeProject {
  return createDefaultProject({
    title,
    seed: graph.seed,
    difficulty: 'custom',
    grid: { rows: graph.rows, cols: graph.cols, minimumCellPixels: 12 },
    mazeGraph: graph,
    mask: graphToMask(graph),
    startCell: { row: 0, col: startCol },
    endCell: { row: graph.rows - 1, col: endCol },
    background: { kind: 'solid', color: '#f4eee6' },
    visualTheme: {
      wallColor: '#c9bfb1',
      pathColor: '#faf6ee',
      startColor: '#5daea1',
      endColor: '#bc9072',
      accentColor: '#438f85',
      wallWidth: 2,
      cornerRadius: 5,
    },
  })
}

/**
 * These are open, gravity-fed layouts, not puzzle-generator mazes. Each active
 * cell has a route to the bottom outlet using only sideways/downward passages.
 * The renderer extrudes the same physical walls; no decorative fake falls are
 * added, and the project remains editable/exportable with the regular tools.
 */
export function createWaterStudioProject(
  id: WaterStudioPresetId = 'cascade',
  seed = 'water-studio',
  size?: WaterStudioSize,
): MazeProject {
  const preset = WATER_STUDIO_PRESETS.find(item => item.id === id)
  if (!preset) throw new RangeError(`Unknown water studio preset: ${id}`)
  const { rows, cols } = size ?? preset
  validateSize({ rows, cols })
  const normalizedSeed = normalizeSeed(seed)
  const random = createSeededRandom(normalizedSeed, `water-studio:${id}`)
  const graph = createEmptyGraph(rows, cols, { seed: normalizedSeed })
  const middle = Math.floor((cols - 1) / 2)
  const mirror = random.boolean()
  const mirrored = (col: number) => mirror ? cols - 1 - col : col

  if (id === 'garden') {
    // Solid islands are part of the physical mask, so water cannot pass through
    // their visible walls. Small dimensions use isolated single-cell islands.
    const islandRows = new Set([Math.max(1, Math.floor(rows * 0.28)), Math.min(rows - 2, Math.floor(rows * 0.65))])
    const leftIsland = random.integer(1, Math.max(2, Math.floor(cols / 2)))
    const islandCols = new Set([leftIsland, cols - 1 - leftIsland])
    for (const cell of graph.cells) {
      if (islandRows.has(cell.row) && islandCols.has(cell.col)) cell.active = false
    }
    for (let row = 0; row < rows; row++) {
      horizontalLane(graph, row)
      if (row < rows - 1) for (let col = 0; col < cols; col++) fall(graph, row, col)
    }
    return projectFor(graph, preset.name, middle, middle)
  }

  for (let row = 0; row < rows; row++) {
    if (id === 'split' && row > 0 && row < rows - 1) {
      const divide = Math.floor(cols / 2)
      horizontalLane(graph, row, 0, divide - 1)
      horizontalLane(graph, row, divide, cols - 1)
    } else {
      horizontalLane(graph, row)
    }
  }

  for (let row = 0; row < rows - 1; row++) {
    if (id === 'cascade') {
      if (row % 2 === 0) {
        // Full-height chambers leave room to see a real falling stream.
        for (let col = 0; col < cols; col++) fall(graph, row, col)
      } else {
        const shelf = Math.floor(row / 2)
        const nearLeft = (shelf % 2 === 0) !== mirror
        const offset = random.integer(0, Math.min(2, cols - 2))
        const first = nearLeft ? offset : cols - 2 - offset
        fall(graph, row, first)
        fall(graph, row, first + 1)
      }
    } else if (id === 'split') {
      const half = Math.floor(cols / 2)
      if (row % 2 === 1) {
        for (let col = 0; col < cols; col++) fall(graph, row, col)
      } else {
        const left = random.integer(0, half)
        fall(graph, row, left)
        fall(graph, row, cols - 1 - left)
      }
    } else {
      // A single gate alternates sides. Insets vary the silhouette while the
      // horizontal rows stay open, so changing the seed never creates a trap.
      const inset = random.integer(0, Math.min(2, cols - 2))
      const gate = mirrored(row % 2 === 0 ? cols - 1 - inset : inset)
      fall(graph, row, gate)
    }
  }
  return projectFor(graph, preset.name, middle, middle)
}

/** Fresh variations with an explicit downhill route, including at small sizes. */
export function generateWaterStudioProject(
  rows: number,
  cols: number,
  seed = 'water-studio',
): MazeProject {
  validateSize({ rows, cols })
  const normalizedSeed = normalizeSeed(seed)
  const random = createSeededRandom(normalizedSeed, 'water-studio:generated')
  const graph = createEmptyGraph(rows, cols, { seed: normalizedSeed })
  for (let row = 0; row < rows; row++) {
    horizontalLane(graph, row)
    if (row === rows - 1) continue
    // Some boundaries are open chambers, some shelves have one or two drains.
    const gateCount = random.boolean(0.28) ? cols : random.integer(1, Math.min(3, cols) + 1)
    for (const col of random.shuffle(Array.from({ length: cols }, (_, index) => index)).slice(0, gateCount)) {
      fall(graph, row, col)
    }
  }
  return projectFor(graph, '새로운 물길', random.integer(0, cols), random.integer(0, cols))
}
