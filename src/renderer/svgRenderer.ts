import { isPointInMaze, type MazePoint, type MazeRenderModel } from './types'

export interface MazeSvgRenderOptions {
  idPrefix?: string
  width?: number
  height?: number
  title?: string
  description?: string
  includeTitle?: boolean
  includeEndpoints?: boolean
  includeMarkers?: boolean
  solution?: ReadonlyArray<MazePoint>
  backgroundColor?: string | null
  mazeFill?: string
  wallColor?: string
  wallWidth?: number
  solutionColor?: string
  startColor?: string
  endColor?: string
  checkpointColor?: string
  collectibleColor?: string
}

const escapeXml = (value: string): string =>
  value.replace(
    /[<>&'"]/g,
    (character) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[character] ?? character,
  )

const finite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback

const compact = (value: number): string =>
  Number(value.toFixed(4))
    .toString()
    .replace(/^-0$/, '0')

const segmentKey = (x1: number, y1: number, x2: number, y2: number): string =>
  x1 < x2 || (x1 === x2 && y1 <= y2)
    ? `${x1},${y1},${x2},${y2}`
    : `${x2},${y2},${x1},${y1}`

const buildWallPath = (model: MazeRenderModel): string => {
  const segments = new Set<string>()
  const add = (x1: number, y1: number, x2: number, y2: number): void => {
    segments.add(segmentKey(x1, y1, x2, y2))
  }
  for (const cell of model.graph.cells) {
    if (!cell.active) continue
    const { row, col, walls } = cell
    if (walls.top) add(col, row, col + 1, row)
    if (walls.right) add(col + 1, row, col + 1, row + 1)
    if (walls.bottom) add(col, row + 1, col + 1, row + 1)
    if (walls.left) add(col, row, col, row + 1)
  }
  return [...segments]
    .sort()
    .map((encoded) => {
      const [x1, y1, x2, y2] = encoded.split(',').map(Number)
      return `M${compact(x1)} ${compact(y1)}L${compact(x2)} ${compact(y2)}`
    })
    .join('')
}

const buildActiveCellPath = (model: MazeRenderModel): string =>
  model.graph.cells
    .filter((cell) => cell.active)
    .map(
      (cell) =>
        `M${compact(cell.col)} ${compact(cell.row)}h1v1h-1z`,
    )
    .join('')

const buildSolutionPath = (
  model: MazeRenderModel,
  solution: ReadonlyArray<MazePoint>,
): string => {
  const safe = solution.filter((point) => isPointInMaze(point, model))
  if (safe.length === 0) return ''
  return safe
    .map((point, index) => {
      const x = compact(point.col + 0.5)
      const y = compact(point.row + 0.5)
      return `${index === 0 ? 'M' : 'L'}${x} ${y}`
    })
    .join('')
}

const markerCircle = (
  point: MazePoint,
  color: string,
  label: string,
  cssClass: string,
  displayLabel = label,
): string => {
  const x = compact(point.col + 0.5)
  const y = compact(point.row + 0.5)
  return `<g class="${cssClass}" role="img" aria-label="${escapeXml(label)}"><circle cx="${x}" cy="${y}" r=".31" fill="${escapeXml(color)}" stroke="#fff" stroke-width=".065"/><text x="${x}" y="${y}" fill="#fff" font-family="system-ui,sans-serif" font-size=".3" font-weight="800" text-anchor="middle" dominant-baseline="central">${escapeXml(displayLabel.slice(0, 2))}</text></g>`
}

let svgInstance = 0

/**
 * Generates self-contained vector markup. User title/description/labels are
 * escaped before interpolation, and no remote resource is referenced.
 */
export const renderMazeSvg = (
  model: MazeRenderModel,
  options: MazeSvgRenderOptions = {},
): string => {
  const cols = Math.max(1, model.graph.cols)
  const rows = Math.max(1, model.graph.rows)
  const includeTitle = Boolean(options.includeTitle && options.title)
  const titleHeight = includeTitle ? Math.max(1.4, rows * 0.07) : 0
  const viewBox = `0 ${compact(-titleHeight)} ${compact(cols)} ${compact(rows + titleHeight)}`
  const width = Math.max(1, finite(options.width ?? cols * 24, cols * 24))
  const height = Math.max(
    1,
    finite(options.height ?? (rows + titleHeight) * 24, (rows + titleHeight) * 24),
  )
  const background = options.backgroundColor === undefined ? '#ffffff' : options.backgroundColor
  const mazeFill = options.mazeFill ?? '#ffffff'
  const wall = options.wallColor ?? '#172033'
  const wallWidth = Math.max(0.01, finite(options.wallWidth ?? 0.08, 0.08))
  const solutionPath = options.solution ? buildSolutionPath(model, options.solution) : ''
  const title = options.title || 'MazeCraft 미로'
  const description =
    options.description || '시작점 S에서 종료점 E까지 이동하는 미로입니다.'
  const idPrefix =
    options.idPrefix?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) ||
    `maze-${++svgInstance}`
  const titleId = `${idPrefix}-title`
  const descriptionId = `${idPrefix}-description`

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${compact(width)}" height="${compact(height)}" viewBox="${viewBox}" role="img" aria-labelledby="${titleId} ${descriptionId}">`,
    `<title id="${titleId}">${escapeXml(title)}</title>`,
    `<desc id="${descriptionId}">${escapeXml(description)}</desc>`,
  ]
  if (background !== null) {
    parts.push(
      `<rect x="0" y="${compact(-titleHeight)}" width="${compact(cols)}" height="${compact(rows + titleHeight)}" fill="${escapeXml(background)}"/>`,
    )
  }
  if (includeTitle) {
    parts.push(
      `<text x="${compact(cols / 2)}" y="${compact(-titleHeight * 0.42)}" fill="${escapeXml(wall)}" font-family="system-ui,sans-serif" font-size="${compact(titleHeight * 0.44)}" font-weight="700" text-anchor="middle" dominant-baseline="central">${escapeXml(title)}</text>`,
    )
  }

  parts.push(
    `<path d="${buildActiveCellPath(model)}" fill="${escapeXml(mazeFill)}" fill-rule="nonzero"/>`,
  )
  if (solutionPath) {
    parts.push(
      `<path d="${solutionPath}" fill="none" stroke="${escapeXml(options.solutionColor ?? '#2563eb')}" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round" opacity=".82"/>`,
    )
  }
  parts.push(
    `<path d="${buildWallPath(model)}" fill="none" stroke="${escapeXml(wall)}" stroke-width="${compact(wallWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`,
  )

  if (options.includeMarkers !== false) {
    for (const checkpoint of model.checkpoints ?? []) {
      if (!isPointInMaze(checkpoint, model)) continue
      parts.push(
        markerCircle(
          checkpoint,
          options.checkpointColor ?? '#f59e0b',
          checkpoint.label || 'C',
          'maze-checkpoint',
        ),
      )
    }
    for (const collectible of model.collectibles ?? []) {
      if (!isPointInMaze(collectible, model)) continue
      parts.push(
        `<circle class="maze-collectible" cx="${compact(collectible.col + 0.5)}" cy="${compact(collectible.row + 0.5)}" r=".2" fill="${escapeXml(options.collectibleColor ?? '#06b6d4')}"><title>${escapeXml(collectible.label || '수집 아이템')}</title></circle>`,
      )
    }
  }

  if (options.includeEndpoints !== false) {
    if (isPointInMaze(model.start, model)) {
      parts.push(
        markerCircle(
          model.start,
          options.startColor ?? '#0f9f6e',
          '시작점 S',
          'maze-start',
          'S',
        ),
      )
    }
    if (isPointInMaze(model.end, model)) {
      parts.push(
        markerCircle(
          model.end,
          options.endColor ?? '#e94c58',
          '종료점 E',
          'maze-end',
          'E',
        ),
      )
    }
  }
  parts.push('</svg>')
  return parts.join('')
}

export const createMazeSvgBlob = (
  model: MazeRenderModel,
  options: MazeSvgRenderOptions = {},
): Blob => new Blob([renderMazeSvg(model, options)], { type: 'image/svg+xml;charset=utf-8' })
