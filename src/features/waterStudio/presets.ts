import {
  closePassage,
  createDefaultProject,
  createEmptyGraph,
  createSeededRandom,
  graphToMask,
  normalizeSeed,
  openPassage,
  type MazeGraph,
  type MazeProject,
} from '../../core/maze'

export type WaterStudioPresetId = 'atelier' | 'cascade' | 'split' | 'serpentine' | 'garden'

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
  { id: 'atelier', name: '포슬린 가든', caption: '분수 섬과 나선을 지나 세 번 넘쳐 흐르는 도자기 미로', rows: 10, cols: 10 },
  { id: 'cascade', name: '캐스케이드', caption: '세 개의 미로 수반을 계단처럼 타고 내려오는 폭포', rows: 8, cols: 6 },
  { id: 'split', name: '트윈 플로우', caption: '양쪽 수반으로 갈라졌다 한곳에서 다시 만나는 물', rows: 8, cols: 8 },
  { id: 'serpentine', name: '리본', caption: '물결 벽 사이를 지그재그로 흘러 네 번 떨어지는 수로', rows: 8, cols: 6 },
  { id: 'garden', name: '워터 가든', caption: '중앙 분수에서 동심원 미로를 따라 퍼져 나가는 원형 정원', rows: 8, cols: 8 },
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

  if (id === 'atelier') {
    if (rows >= 10 && cols >= 10) {
      // The strokes describe a single-level ceramic garden, with large U/C
      // chambers, a broken central ring and clear passages between them.
      // They remain ordinary grid walls for editing, export and simulation;
      // the ceramic mesher rounds the connected corners of the same walls.
      const x = (value: number) => Math.round(value * cols / 10)
      const y = (value: number) => Math.round(value * rows / 10)
      const island = (row: number, col: number) => {
        graph.cells[Math.floor(row * rows / 10) * cols + mirrored(Math.floor(col * cols / 10))].active = false
      }
      island(5, 5)
      island(random.boolean() ? 2 : 3, 2)
      for (let row = 0; row < rows; row++) {
        horizontalLane(graph, row)
        if (row < rows - 1) for (let col = 0; col < cols; col++) fall(graph, row, col)
      }
      const stroke = (points: readonly (readonly [number, number])[]) => {
        for (let segment = 1; segment < points.length; segment++) {
          const [ax, ay] = points[segment - 1], [bx, by] = points[segment]
          if (ay === by) {
            for (let col = x(Math.min(ax, bx)); col < x(Math.max(ax, bx)); col++) {
              closePassage(graph, { row: y(ay) - 1, col: mirrored(col) }, { row: y(ay), col: mirrored(col) })
            }
          } else {
            for (let row = y(Math.min(ay, by)); row < y(Math.max(ay, by)); row++) {
              closePassage(graph, { row, col: mirrored(x(ax) - 1) }, { row, col: mirrored(x(ax)) })
            }
          }
        }
      }
      // Upper left inlet garden: the opening above its island splits the flow.
      stroke([[1, 4], [1, 1], [2, 1]])
      stroke([[3, 1], [4, 1], [4, random.boolean() ? 3 : 4]])
      // Broad right-hand hook, open below; the short foot turns the water
      // without sealing the base of its chamber.
      stroke([[6, random.boolean() ? 3 : 4], [6, 1], [9, 1], [9, 4], [8, 4]])
      // Central island loop has real inlet/outlet gates, so it is never a
      // decorative ring with inaccessible water or a sealed lower pocket.
      stroke([[5, 4], [4, 4], [4, 7], [5, 7]])
      stroke([[6, 4], [7, 4], [7, 7], [6, 7]])
      // Unequal lower U-shaped bays connect to the open outlet promenade.
      stroke([[1, 9], [1, 6], [3, 6], [3, random.boolean() ? 8 : 9]])
      stroke([[7, 9], [7, 7]])
      stroke([[8, 7], [8, 6], [9, 6], [9, 9], [8, 9]])
      return projectFor(graph, preset.name, mirrored(Math.floor(cols * 0.25)), mirrored(Math.floor(cols * 0.65)))
    }

    // Compact editor sizes retain a simple S passage with room to turn. The
    // larger sculptural chambers would lose their drain openings below 10×10.
    for (let row = 0; row < rows; row++) {
      horizontalLane(graph, row)
      if (row < rows - 1) for (let col = 0; col < cols; col++) fall(graph, row, col)
    }
    const shelves = Math.min(6, Math.max(1, Math.floor((rows - 1) / 3)))
    const gateWidth = Math.max(1, Math.round(cols / 4))
    const reach = cols - gateWidth
    for (let shelf = 0; shelf < shelves; shelf++) {
      const nearLeft = (shelf % 2 === 0) !== mirror
      const column = (offset: number) => nearLeft ? offset : cols - 1 - offset
      const base = 1 + Math.floor(shelf * rows / shelves)
      const bend = Math.max(1, Math.min(reach - 1, Math.floor(reach / 2) + random.integer(-1, 2)))
      for (let offset = 0; offset < reach; offset++) {
        const row = base + (offset >= bend ? 1 : 0)
        const col = column(offset)
        closePassage(graph, { row, col }, { row: row + 1, col })
      }
      closePassage(graph,
        { row: base + 1, col: column(bend - 1) },
        { row: base + 1, col: column(bend) },
      )
    }
    const lastNearLeft = ((shelves - 1) % 2 === 0) !== mirror
    const endCol = lastNearLeft ? cols - 1 - Math.floor(gateWidth / 2) : Math.floor(gateWidth / 2)
    return projectFor(graph, preset.name, mirrored(1), endCol)
  }

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
