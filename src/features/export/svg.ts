import type {
  CellPosition,
  MazeGraph,
  MazeProject,
  WallDirection,
} from '../../core/maze/types'
import { getVisualOpeningDirection } from '../../core/maze/graph'

export interface MazeSvgOptions {
  includeBackground?: boolean
  transparentBackground?: boolean
  includeEndpoints?: boolean
  includeSolution?: boolean
  solutionPath?: CellPosition[]
  includeTitle?: boolean
}

function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function safeColor(value: string, fallback: string): string {
  const color = value.trim()
  if (
    /^#[\da-f]{3,4}$/i.test(color) ||
    /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color) ||
    /^(?:rgb|hsl)a?\([\d\s.,%/+*-]+\)$/i.test(color) ||
    color === 'transparent'
  ) {
    return color
  }
  return fallback
}

function safeDataImage(value: string): string | null {
  return /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(
    value,
  )
    ? value
    : null
}

function cellCenter(
  cell: CellPosition,
  cellWidth: number,
  cellHeight: number,
): [number, number] {
  return [
    (cell.col + 0.5) * cellWidth,
    (cell.row + 0.5) * cellHeight,
  ]
}

function wallSegments(
  graph: MazeGraph,
  startCell: CellPosition,
  endCell: CellPosition,
  cellWidth: number,
  cellHeight: number,
): string[] {
  const segments = new Set<string>()
  const openings = new Map<number, WallDirection>()
  for (const endpoint of [startCell, endCell]) {
    const direction = getVisualOpeningDirection(graph, endpoint)
    if (direction) openings.set(endpoint.row * graph.cols + endpoint.col, direction)
  }
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    const a = `${x1.toFixed(3)},${y1.toFixed(3)}`
    const b = `${x2.toFixed(3)},${y2.toFixed(3)}`
    segments.add(a < b ? `${a} ${b}` : `${b} ${a}`)
  }

  for (const cell of graph.cells) {
    if (!cell.active) continue
    const left = cell.col * cellWidth
    const right = left + cellWidth
    const top = cell.row * cellHeight
    const bottom = top + cellHeight
    const opening = openings.get(cell.index)
    if (cell.walls.top && opening !== 'top') add(left, top, right, top)
    if (cell.walls.right && opening !== 'right') add(right, top, right, bottom)
    if (cell.walls.bottom && opening !== 'bottom') add(left, bottom, right, bottom)
    if (cell.walls.left && opening !== 'left') add(left, top, left, bottom)
  }
  return [...segments]
}

function backgroundMarkup(
  project: MazeProject,
  width: number,
  height: number,
): string {
  const background = project.background
  if (background.kind === 'image') {
    const imageData = safeDataImage(background.dataUrl)
    return `<rect width="${width}" height="${height}" fill="${escapeXml(
      safeColor(project.visualTheme.pathColor, '#ffffff'),
    )}"/>${
      imageData
        ? `<image href="${escapeXml(
            imageData,
          )}" width="${width}" height="${height}" opacity="${Math.max(
            0,
            Math.min(1, background.opacity),
          )}" preserveAspectRatio="xMidYMid ${
            background.fit === 'contain' ? 'meet' : 'slice'
          }"/>`
        : ''
    }`
  }
  if (background.kind === 'grid') {
    const patternId = `grid-${project.id.replace(/[^a-zA-Z0-9_-]/g, '')}`
    const spacing = Math.max(4, background.spacing)
    return `<defs><pattern id="${patternId}" width="${spacing}" height="${spacing}" patternUnits="userSpaceOnUse"><path d="M ${spacing} 0 L 0 0 0 ${spacing}" fill="none" stroke="${escapeXml(
      safeColor(background.lineColor, '#e5e7eb'),
    )}" stroke-width="0.5"/></pattern></defs><rect width="${width}" height="${height}" fill="${escapeXml(
      safeColor(background.color, '#ffffff'),
    )}"/><rect width="${width}" height="${height}" fill="url(#${patternId})"/>`
  }
  return `<rect width="${width}" height="${height}" fill="${escapeXml(
    safeColor(background.color, '#ffffff'),
  )}"/>`
}

export function renderMazeSvg(
  project: MazeProject,
  options: MazeSvgOptions = {},
): string {
  const width = finitePositive(project.canvas.width, 1000)
  const height = finitePositive(project.canvas.height, 1000)
  const rows = Math.max(1, project.mazeGraph.rows)
  const cols = Math.max(1, project.mazeGraph.cols)
  const cellWidth = width / cols
  const cellHeight = height / rows
  const theme = project.visualTheme
  const lines = wallSegments(
    project.mazeGraph,
    project.startCell,
    project.endCell,
    cellWidth,
    cellHeight,
  )
  const wallPath = lines
    .map((line) => {
      const [start, end] = line.split(' ')
      return `M${start} L${end}`
    })
    .join(' ')
  const includeBackground =
    options.includeBackground !== false && !options.transparentBackground
  const includeEndpoints = options.includeEndpoints !== false

  const solution =
    options.includeSolution && options.solutionPath?.length
      ? (() => {
          const points = options.solutionPath
            .map((cell) => cellCenter(cell, cellWidth, cellHeight).join(','))
            .join(' ')
          return `<polyline points="${points}" fill="none" stroke="${escapeXml(
            safeColor(theme.accentColor, '#3458eb'),
          )}" stroke-width="${Math.max(
            1,
            Math.min(cellWidth, cellHeight) * 0.22,
          )}" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>`
        })()
      : ''

  const endpoints = includeEndpoints
    ? [project.startCell, project.endCell]
        .map((cell, index) => {
          const [x, y] = cellCenter(cell, cellWidth, cellHeight)
          const isStart = index === 0
          const radius = Math.max(
            1.5,
            Math.min(cellWidth, cellHeight) * 0.3,
          )
          return `<g aria-label="${
            isStart ? '시작점' : '종료점'
          }"><circle cx="${x}" cy="${y}" r="${radius}" fill="${escapeXml(
            safeColor(
              isStart ? theme.startColor : theme.endColor,
              isStart ? '#16855b' : '#d24b4b',
            ),
          )}"/><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="#fff" font-family="system-ui,sans-serif" font-size="${Math.max(
            2.5,
            radius,
          )}" font-weight="700">${isStart ? 'S' : 'E'}</text></g>`
        })
        .join('')
    : ''

  const title = options.includeTitle
    ? `<title>${escapeXml(project.title)}</title>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(
    project.title,
  )} 미로">${title}${includeBackground ? backgroundMarkup(project, width, height) : ''}${solution}<path d="${wallPath}" fill="none" stroke="${escapeXml(
    safeColor(theme.wallColor, '#172033'),
  )}" stroke-width="${Math.max(
    0.5,
    theme.wallWidth,
  )}" stroke-linecap="round" stroke-linejoin="round"/>${endpoints}</svg>`
}

export function mazeSvgBlob(
  project: MazeProject,
  options: MazeSvgOptions = {},
): Blob {
  return new Blob([renderMazeSvg(project, options)], {
    type: 'image/svg+xml;charset=utf-8',
  })
}
