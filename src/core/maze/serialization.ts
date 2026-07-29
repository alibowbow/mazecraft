import { generateMaze } from './generate'
import {
  graphToMask,
  isPositionInside,
  normalizeMask,
  normalizeWallSymmetry,
} from './graph'
import { calculateMazeMetrics } from './metrics'
import { optimizeEndpoints } from './endpoints'
import type {
  BackgroundSettings,
  CellPosition,
  CellWalls,
  CreatorReplay,
  DifficultyLevel,
  ExportSettings,
  GameRules,
  MazeAlgorithm,
  MazeGraph,
  MazeProject,
  MazeShape,
  MoveDirection,
  PlacedItem,
  RemixAttribution,
  SecretRevealSettings,
  VisualTheme,
} from './types'
import {
  CURRENT_APP_VERSION,
  CURRENT_SCHEMA_VERSION,
  MAZE_GRAPH_VERSION,
} from './types'

const DEFAULT_IMPORT_LIMIT_BYTES = 10 * 1024 * 1024
let fallbackProjectSequence = 0

type JsonRecord = Record<string, unknown>

export class ProjectImportError extends Error {
  readonly code:
    | 'file-too-large'
    | 'invalid-json'
    | 'invalid-project'
    | 'unsupported-version'

  constructor(code: ProjectImportError['code'], message: string) {
    super(message)
    this.name = 'ProjectImportError'
    this.code = code
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)))
}

function safeString(value: unknown, fallback: string, maximumLength: number): string {
  if (typeof value !== 'string') return fallback
  return value.replace(/\u0000/g, '').slice(0, maximumLength)
}

function safeIsoDate(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback
  return new Date(value).toISOString()
}

function safeId(value: unknown, fallback: string): string {
  const candidate = safeString(value, fallback, 160).trim()
  return candidate || fallback
}

function createProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  fallbackProjectSequence += 1
  return `maze-${Date.now().toString(36)}-${fallbackProjectSequence.toString(36)}`
}

function readPosition(value: unknown): CellPosition | undefined {
  if (!isRecord(value)) return undefined
  const row = finiteNumber(value.row, Number.NaN)
  const col = finiteNumber(value.col, Number.NaN)
  if (!Number.isInteger(row) || !Number.isInteger(col)) return undefined
  return { row, col }
}

function readWalls(value: unknown): CellWalls {
  if (Array.isArray(value)) {
    return {
      top: Boolean(value[0]),
      right: Boolean(value[1]),
      bottom: Boolean(value[2]),
      left: Boolean(value[3]),
    }
  }
  if (!isRecord(value)) {
    return { top: true, right: true, bottom: true, left: true }
  }
  return {
    top: Boolean(value.top ?? value.north ?? true),
    right: Boolean(value.right ?? value.east ?? true),
    bottom: Boolean(value.bottom ?? value.south ?? true),
    left: Boolean(value.left ?? value.west ?? true),
  }
}

function readAlgorithm(value: unknown): MazeAlgorithm {
  return value === 'dfs' || value === 'kruskal' || value === 'prim' ? value : 'dfs'
}

function normalizeImportedGraph(value: unknown, fallbackSeed: string): MazeGraph {
  let rows: number
  let cols: number
  let sourceCells: unknown[]
  let record: JsonRecord | undefined

  if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
    const matrix = value as unknown[][]
    rows = matrix.length
    cols = matrix[0].length
    if (cols < 1 || matrix.some((line) => line.length !== cols)) {
      throw new ProjectImportError('invalid-project', '미로 행의 길이가 일정하지 않습니다.')
    }
    sourceCells = matrix.flat()
  } else if (isRecord(value)) {
    record = value
    rows = finiteNumber(value.rows, 0)
    cols = finiteNumber(value.cols, 0)
    const cellsValue = value.cells
    if (Array.isArray(cellsValue) && cellsValue.length > 0 && Array.isArray(cellsValue[0])) {
      sourceCells = (cellsValue as unknown[][]).flat()
    } else if (Array.isArray(cellsValue)) {
      sourceCells = cellsValue
    } else {
      throw new ProjectImportError('invalid-project', '미로 셀 데이터가 없습니다.')
    }
  } else {
    throw new ProjectImportError('invalid-project', '미로 그래프 형식이 올바르지 않습니다.')
  }

  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 1 ||
    cols < 1 ||
    rows > 500 ||
    cols > 500 ||
    sourceCells.length !== rows * cols
  ) {
    throw new ProjectImportError(
      'invalid-project',
      '미로 격자 크기와 셀 데이터 수가 일치하지 않습니다.',
    )
  }

  const cells = sourceCells.map((source, index) => {
    const cell = isRecord(source) ? source : {}
    return {
      index,
      row: Math.floor(index / cols),
      col: index % cols,
      active: cell.active === undefined ? true : Boolean(cell.active),
      walls: readWalls(cell.walls ?? cell),
    }
  })
  const graph: MazeGraph = {
    version: MAZE_GRAPH_VERSION,
    rows,
    cols,
    cells,
    algorithm: readAlgorithm(record?.algorithm),
    seed: safeString(record?.seed, fallbackSeed, 256),
  }
  normalizeWallSymmetry(graph)
  return graph
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined
  try {
    const parsed = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : undefined
  } catch {
    return undefined
  }
}

const imageMediaTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
] as const

type SafeImageMediaType = (typeof imageMediaTypes)[number]

function safeSvgMarkup(markup: string): boolean {
  if (
    /<\s*(?:script|style|foreignObject|iframe|object|embed|audio|video|link|meta|animate|animateMotion|animateTransform|set|discard)\b/i.test(
      markup,
    ) ||
    /<\s*!doctype\b/i.test(markup) ||
    /<\?xml-stylesheet\b/i.test(markup) ||
    /\bon[a-z]+\s*=/i.test(markup) ||
    /\bstyle\s*=/i.test(markup) ||
    /\bxml:base\s*=/i.test(markup) ||
    /(?:javascript\s*:|@import\b|expression\s*\(|behavior\s*:|-moz-binding)/i.test(
      markup,
    )
  ) {
    return false
  }

  const references = markup.matchAll(
    /\b(?:href|xlink:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  )
  for (const match of references) {
    const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (
      !/^#[A-Za-z_][\w:.-]*$/.test(reference) &&
      !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(
        reference,
      )
    ) {
      return false
    }
  }

  const paintServers = markup.matchAll(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]+))\s*\)/gi,
  )
  for (const match of paintServers) {
    const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!/^#[A-Za-z_][\w:.-]*$/.test(reference)) return false
  }

  if (typeof DOMParser === 'undefined') return false
  const documentNode = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = documentNode.documentElement
  if (
    documentNode.querySelector('parsererror') ||
    root.localName.toLowerCase() !== 'svg'
  ) {
    return false
  }

  for (const node of documentNode.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (
        name.startsWith('on') ||
        name === 'style' ||
        name === 'xml:base' ||
        /(?:javascript\s*:|@import\b|expression\s*\(|behavior\s*:|-moz-binding)/i.test(
          value,
        ) ||
        value.includes('\\')
      ) {
        return false
      }
      if (name === 'href' || name === 'xlink:href' || name === 'src') {
        if (
          !/^#[A-Za-z_][\w:.-]*$/.test(value) &&
          !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(
            value,
          )
        ) {
          return false
        }
      }
      for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
        if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2].trim())) return false
      }
    }
  }
  return true
}

function safeImageDataUrl(
  value: unknown,
): { dataUrl: string; mediaType: SafeImageMediaType } | undefined {
  if (typeof value !== 'string' || value.length > 20 * 1024 * 1024) {
    return undefined
  }
  const match = value.match(
    /^data:(image\/(?:jpeg|png|webp|svg\+xml));base64,([a-z0-9+/=\s]+)$/i,
  )
  if (!match) return undefined
  const mediaType = match[1].toLowerCase() as SafeImageMediaType
  if (!imageMediaTypes.includes(mediaType)) return undefined
  if (mediaType === 'image/svg+xml') {
    try {
      const binary = atob(match[2].replace(/\s/g, ''))
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      )
      if (!safeSvgMarkup(new TextDecoder().decode(bytes))) return undefined
    } catch {
      return undefined
    }
  }
  return { dataUrl: value, mediaType }
}

function normalizeShape(value: unknown, fallback: MazeShape): MazeShape {
  if (!isRecord(value)) return fallback
  const basicNames = [
    'rectangle',
    'rounded-rectangle',
    'circle',
    'ellipse',
    'heart',
    'star',
    'diamond',
    'hexagon',
    'crescent',
    'cloud',
    'flower',
    'tree',
    'house',
    'crown',
    'lightning',
    'speech-bubble',
    'puzzle',
  ]
  if (
    value.kind === 'basic' &&
    typeof value.name === 'string' &&
    basicNames.includes(value.name)
  ) {
    return {
      kind: 'basic',
      name: value.name as Extract<MazeShape, { kind: 'basic' }>['name'],
      inset: boundedNumber(value.inset, 0, 0, 0.45),
    }
  }
  if (value.kind === 'text' && isRecord(value.settings)) {
    const settings = value.settings
    return {
      kind: 'text',
      settings: {
        text: safeString(settings.text, '', 10_000),
        mode:
          settings.mode === 'obstacle' || settings.mode === 'secret'
            ? settings.mode
            : 'outline',
        fontFamily:
          typeof settings.fontFamily === 'string' &&
          !/(?:url\s*\(|@import)/i.test(settings.fontFamily)
            ? safeString(settings.fontFamily, 'system-ui, sans-serif', 200)
            : 'system-ui, sans-serif',
        fontWeight: Math.round(
          boundedNumber(settings.fontWeight, 700, 100, 900),
        ),
        letterSpacing: boundedNumber(settings.letterSpacing, 0, -20, 100),
        lineHeight: boundedNumber(settings.lineHeight, 1.1, 0.5, 5),
        horizontalAlign:
          settings.horizontalAlign === 'left' ||
          settings.horizontalAlign === 'right'
            ? settings.horizontalAlign
            : 'center',
        verticalAlign:
          settings.verticalAlign === 'top' ||
          settings.verticalAlign === 'bottom'
            ? settings.verticalAlign
            : 'middle',
        autoFit:
          settings.autoFit === undefined ? true : Boolean(settings.autoFit),
      },
    }
  }
  if (value.kind === 'image' && isRecord(value.settings)) {
    const settings = value.settings
    const image = safeImageDataUrl(settings.dataUrl)
    if (!image) return fallback
    const crop = isRecord(settings.crop) ? settings.crop : {}
    return {
      kind: 'image',
      settings: {
        mediaType: image.mediaType,
        dataUrl: image.dataUrl,
        crop: {
          x: boundedNumber(crop.x, 0, -2, 2),
          y: boundedNumber(crop.y, 0, -2, 2),
          width: boundedNumber(crop.width, 1, 0.01, 4),
          height: boundedNumber(crop.height, 1, 0.01, 4),
        },
        scale: boundedNumber(settings.scale, 1, 0.05, 10),
        rotation: boundedNumber(settings.rotation, 0, -360, 360),
        grayscale:
          settings.grayscale === undefined
            ? true
            : Boolean(settings.grayscale),
        threshold: boundedNumber(settings.threshold, 170, 0, 255),
        inverted: Boolean(settings.inverted),
        smoothing: boundedNumber(settings.smoothing, 1, 0, 3),
        noiseRemoval: Math.round(
          boundedNumber(settings.noiseRemoval, 3, 0, 10_000),
        ),
        fillInterior:
          settings.fillInterior === undefined
            ? true
            : Boolean(settings.fillInterior),
        largestComponentOnly:
          settings.largestComponentOnly === undefined
            ? true
            : Boolean(settings.largestComponentOnly),
      },
    }
  }
  if (value.kind === 'drawing' && Array.isArray(value.paths)) {
    const paths = value.paths.slice(0, 1_000).flatMap((path) => {
      if (!Array.isArray(path)) return []
      const points = path.slice(0, 20_000).flatMap((point) => {
        if (!isRecord(point)) return []
        const x = finiteNumber(point.x, Number.NaN)
        const y = finiteNumber(point.y, Number.NaN)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return []
        return [
          {
            x: Math.min(1, Math.max(0, x)),
            y: Math.min(1, Math.max(0, y)),
            pressure: boundedNumber(point.pressure, 1, 0, 1),
          },
        ]
      })
      return points.length ? [points] : []
    })
    return {
      kind: 'drawing',
      paths,
      brushSize: boundedNumber(value.brushSize, 0.045, 0.001, 0.5),
    }
  }
  return fallback
}

function normalizeTheme(value: unknown, fallback: VisualTheme): VisualTheme {
  if (!isRecord(value)) return fallback
  return {
    wallColor: safeString(value.wallColor, fallback.wallColor, 80),
    pathColor: safeString(value.pathColor, fallback.pathColor, 80),
    startColor: safeString(value.startColor, fallback.startColor, 80),
    endColor: safeString(value.endColor, fallback.endColor, 80),
    accentColor: safeString(value.accentColor, fallback.accentColor, 80),
    wallWidth: boundedNumber(value.wallWidth, fallback.wallWidth, 0.5, 20),
    cornerRadius: boundedNumber(value.cornerRadius, fallback.cornerRadius, 0, 50),
  }
}

function normalizeBackground(
  value: unknown,
  fallback: BackgroundSettings,
): BackgroundSettings {
  if (!isRecord(value)) return fallback
  if (value.kind === 'solid' && typeof value.color === 'string') {
    return { kind: 'solid', color: safeString(value.color, '#ffffff', 80) }
  }
  if (
    value.kind === 'grid' &&
    typeof value.color === 'string' &&
    typeof value.lineColor === 'string'
  ) {
    return {
      kind: 'grid',
      color: safeString(value.color, '#ffffff', 80),
      lineColor: safeString(value.lineColor, '#e5e7eb', 80),
      spacing: boundedNumber(value.spacing, 16, 2, 200),
    }
  }
  if (value.kind === 'paper' && typeof value.color === 'string') {
    return {
      kind: 'paper',
      color: safeString(value.color, '#ffffff', 80),
      grain: boundedNumber(value.grain, 0.08, 0, 1),
    }
  }
  if (
    value.kind === 'image' &&
    safeImageDataUrl(value.dataUrl)
  ) {
    const image = safeImageDataUrl(value.dataUrl)!
    return {
      kind: 'image',
      dataUrl: image.dataUrl,
      opacity: boundedNumber(value.opacity, 1, 0, 1),
      fit: value.fit === 'contain' ? 'contain' : 'cover',
    }
  }
  return fallback
}

function normalizeRules(value: unknown, fallback: GameRules): GameRules {
  if (!isRecord(value)) return fallback
  const mode =
    value.mode === 'time-attack' || value.mode === 'checkpoint'
      ? value.mode
      : 'classic'
  return {
    mode,
    timeLimitSeconds:
      value.timeLimitSeconds === null
        ? null
        : Math.round(boundedNumber(value.timeLimitSeconds, 0, 0, 86400)) || null,
    allowedHints: Math.round(boundedNumber(value.allowedHints, 3, 0, 99)),
    showDpad: value.showDpad === undefined ? fallback.showDpad : Boolean(value.showDpad),
    soundEnabled:
      value.soundEnabled === undefined ? fallback.soundEnabled : Boolean(value.soundEnabled),
    ghostAllowed:
      value.ghostAllowed === undefined ? fallback.ghostAllowed : Boolean(value.ghostAllowed),
  }
}

function normalizeItems(value: unknown, graph: MazeGraph): PlacedItem[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, graph.cells.length)
    .flatMap((item, index): PlacedItem[] => {
      if (!isRecord(item)) return []
      const position = readPosition(item)
      if (!position || !isPositionInside(graph.rows, graph.cols, position)) return []
      return [
        {
          ...position,
          id: safeId(item.id, `item-${index}`),
          label: safeString(item.label, '', 200),
        },
      ]
    })
}

function normalizeSecret(
  value: unknown,
  fallback: SecretRevealSettings,
): SecretRevealSettings {
  if (!isRecord(value) || !isRecord(value.content)) return fallback
  const mode =
    value.mode === 'visited-cells' ||
    value.mode === 'solution-path' ||
    value.mode === 'checkpoints'
      ? value.mode
      : 'on-complete'
  const animation =
    value.animation === 'puzzle' ||
    value.animation === 'unmask' ||
    value.animation === 'zoom' ||
    value.animation === 'none'
      ? value.animation
      : 'fade'
  const content = value.content

  if (content.kind === 'message') {
    return {
      mode,
      animation,
      content: { kind: 'message', message: safeString(content.message, '', 20_000) },
    }
  }
  if (
    content.kind === 'image' &&
    safeImageDataUrl(content.imageDataUrl)
  ) {
    const image = safeImageDataUrl(content.imageDataUrl)!
    return {
      mode,
      animation,
      content: {
        kind: 'image',
        imageDataUrl: image.dataUrl,
        alt: safeString(content.alt, '', 500),
      },
    }
  }
  if (
    content.kind === 'image-message' &&
    safeImageDataUrl(content.imageDataUrl)
  ) {
    const image = safeImageDataUrl(content.imageDataUrl)!
    return {
      mode,
      animation,
      content: {
        kind: 'image-message',
        imageDataUrl: image.dataUrl,
        alt: safeString(content.alt, '', 500),
        message: safeString(content.message, '', 20_000),
      },
    }
  }
  if (content.kind === 'link') {
    const url = safeUrl(content.url)
    return url
      ? {
          mode,
          animation,
          content: {
            kind: 'link',
            label: safeString(content.label, '링크 열기', 200),
            url,
          },
        }
      : fallback
  }
  if (content.kind === 'coupon') {
    return {
      mode,
      animation,
      content: {
        kind: 'coupon',
        code: safeString(content.code, '', 500),
        message: safeString(content.message, '', 5_000),
      },
    }
  }
  if (content.kind === 'hint') {
    return {
      mode,
      animation,
      content: {
        kind: 'hint',
        message: safeString(content.message, '', 5_000),
        nextLocation: safeString(content.nextLocation, '', 1_000),
      },
    }
  }
  return { mode, animation, content: { kind: 'none' } }
}

function normalizeReplay(value: unknown, graph: MazeGraph): CreatorReplay | null {
  if (!isRecord(value) || !Array.isArray(value.frames)) return null
  const frames: CreatorReplay['frames'] = value.frames.slice(0, 250_000).flatMap((frame) => {
    if (!isRecord(frame)) return []
    const position = readPosition(frame)
    if (!position || !isPositionInside(graph.rows, graph.cols, position)) return []
    const atMs = boundedNumber(frame.atMs, 0, 0, 86_400_000)
    const direction: MoveDirection | undefined =
      frame.direction === 'up' ||
      frame.direction === 'right' ||
      frame.direction === 'down' ||
      frame.direction === 'left'
        ? frame.direction
        : undefined
    return [
      {
        ...position,
        atMs,
        ...(direction ? { direction } : {}),
        ...(typeof frame.checkpointId === 'string'
          ? { checkpointId: safeString(frame.checkpointId, '', 160) }
          : {}),
        ...(typeof frame.usedHint === 'boolean' ? { usedHint: frame.usedHint } : {}),
      },
    ]
  })
  frames.sort((left, right) => left.atMs - right.atMs)
  return {
    durationMs: boundedNumber(value.durationMs, frames.at(-1)?.atMs ?? 0, 0, 86_400_000),
    frames,
    completed: Boolean(value.completed),
  }
}

function normalizeExport(
  value: unknown,
  fallback: ExportSettings,
): ExportSettings {
  if (!isRecord(value)) return fallback
  return {
    scale: value.scale === 2 || value.scale === 4 ? value.scale : 1,
    transparentBackground: Boolean(value.transparentBackground),
    includeEndpoints:
      value.includeEndpoints === undefined
        ? fallback.includeEndpoints
        : Boolean(value.includeEndpoints),
    includeSolution: Boolean(value.includeSolution),
    printOrientation: value.printOrientation === 'landscape' ? 'landscape' : 'portrait',
    printTitle: value.printTitle === undefined ? fallback.printTitle : Boolean(value.printTitle),
    printNameField:
      value.printNameField === undefined
        ? fallback.printNameField
        : Boolean(value.printNameField),
    printAnswerSheet:
      value.printAnswerSheet === undefined
        ? fallback.printAnswerSheet
        : Boolean(value.printAnswerSheet),
  }
}

function normalizeAttribution(value: unknown): RemixAttribution | null {
  if (!isRecord(value)) return null
  if (typeof value.sourceProjectId !== 'string' || typeof value.sourceTitle !== 'string') {
    return null
  }
  return {
    sourceProjectId: safeId(value.sourceProjectId, 'unknown'),
    sourceTitle: safeString(value.sourceTitle, '이름 없는 미로', 200),
    ...(typeof value.creatorDisplayName === 'string'
      ? {
          creatorDisplayName: safeString(value.creatorDisplayName, '', 120),
        }
      : {}),
  }
}

function defaultProjectFromGraph(
  graph: MazeGraph,
  start: CellPosition,
  end: CellPosition,
  now: string,
): MazeProject {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: CURRENT_APP_VERSION,
    id: createProjectId(),
    title: '이름 없는 미로',
    description: '',
    creatorDisplayName: '',
    createdAt: now,
    updatedAt: now,
    seed: graph.seed,
    canvas: { width: 1200, height: 1200, aspectRatio: '1:1' },
    grid: { rows: graph.rows, cols: graph.cols, minimumCellPixels: 8 },
    shape: { kind: 'basic', name: 'rectangle', inset: 0 },
    mask: graphToMask(graph),
    mazeGraph: graph,
    startCell: start,
    endCell: end,
    difficulty: 'normal',
    mazeMetrics: calculateMazeMetrics(graph, start, end),
    visualTheme: {
      wallColor: '#172033',
      pathColor: '#f8fafc',
      startColor: '#0f9f6e',
      endColor: '#e5484d',
      accentColor: '#5267df',
      wallWidth: 2,
      cornerRadius: 0,
    },
    background: { kind: 'solid', color: '#ffffff' },
    gameRules: {
      mode: 'classic',
      timeLimitSeconds: null,
      allowedHints: 3,
      showDpad: true,
      soundEnabled: true,
      ghostAllowed: true,
    },
    collectibles: [],
    checkpoints: [],
    secretReveal: {
      content: { kind: 'none' },
      mode: 'on-complete',
      animation: 'fade',
    },
    creatorReplay: null,
    exportSettings: {
      scale: 2,
      transparentBackground: false,
      includeEndpoints: true,
      includeSolution: false,
      printOrientation: 'portrait',
      printTitle: true,
      printNameField: true,
      printAnswerSheet: true,
    },
    attribution: null,
    remixAllowed: true,
  }
}

export function createDefaultProject(
  overrides: Partial<MazeProject> = {},
): MazeProject {
  const seed = overrides.seed ?? `maze-${Date.now().toString(36)}`
  const generated =
    overrides.mazeGraph && overrides.startCell && overrides.endCell
      ? {
          graph: overrides.mazeGraph,
          start: overrides.startCell,
          end: overrides.endCell,
        }
      : generateMaze({
          rows: overrides.grid?.rows ?? 24,
          cols: overrides.grid?.cols ?? 24,
          seed,
          algorithm: overrides.mazeGraph?.algorithm ?? 'kruskal',
          mask: overrides.mask,
        })
  const now = new Date().toISOString()
  const base = defaultProjectFromGraph(
    generated.graph,
    generated.start,
    generated.end,
    now,
  )
  return {
    ...base,
    ...overrides,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: overrides.appVersion ?? CURRENT_APP_VERSION,
    seed: generated.graph.seed,
    mazeGraph: generated.graph,
    mask: overrides.mask ?? graphToMask(generated.graph),
    startCell: generated.start,
    endCell: generated.end,
    mazeMetrics:
      overrides.mazeMetrics ??
      calculateMazeMetrics(generated.graph, generated.start, generated.end),
  }
}

export function migrateProject(input: unknown): MazeProject {
  if (!isRecord(input)) {
    throw new ProjectImportError('invalid-project', '프로젝트 최상위 형식이 올바르지 않습니다.')
  }
  const schemaVersion =
    typeof input.schemaVersion === 'number' ? input.schemaVersion : 0
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new ProjectImportError(
      'unsupported-version',
      `이 프로젝트는 더 새로운 스키마 버전(${schemaVersion})으로 저장되었습니다.`,
    )
  }
  if (schemaVersion < 0 || !Number.isInteger(schemaVersion)) {
    throw new ProjectImportError('invalid-project', '스키마 버전이 올바르지 않습니다.')
  }

  const seed = safeString(input.seed, 'imported-maze', 256)
  const graphSource = input.mazeGraph ?? input.maze
  const graph = normalizeImportedGraph(graphSource, seed)
  const now = new Date().toISOString()
  let start = readPosition(input.startCell ?? input.start)
  let end = readPosition(input.endCell ?? input.end)
  if (
    !start ||
    !end ||
    !isPositionInside(graph.rows, graph.cols, start) ||
    !isPositionInside(graph.rows, graph.cols, end) ||
    !graph.cells[start.row * graph.cols + start.col]?.active ||
    !graph.cells[end.row * graph.cols + end.col]?.active
  ) {
    const endpoints = optimizeEndpoints(graph)
    start = endpoints.start
    end = endpoints.end
  }

  const fallback = defaultProjectFromGraph(graph, start, end, now)
  const canvas = isRecord(input.canvas)
    ? {
        width: boundedNumber(input.canvas.width, fallback.canvas.width, 64, 16384),
        height: boundedNumber(input.canvas.height, fallback.canvas.height, 64, 16384),
        aspectRatio: [
          '1:1',
          '4:3',
          '3:4',
          '16:9',
          '9:16',
          'a4-portrait',
          'a4-landscape',
        ].includes(String(input.canvas.aspectRatio))
          ? (input.canvas.aspectRatio as MazeProject['canvas']['aspectRatio'])
          : fallback.canvas.aspectRatio,
      }
    : fallback.canvas
  const difficulty: DifficultyLevel =
    input.difficulty === 'very-easy' ||
    input.difficulty === 'easy' ||
    input.difficulty === 'hard' ||
    input.difficulty === 'expert' ||
    input.difficulty === 'custom'
      ? input.difficulty
      : 'normal'

  let mask = graphToMask(graph)
  if (isRecord(input.mask) || Array.isArray(input.mask)) {
    try {
      const candidate = isRecord(input.mask) && Array.isArray(input.mask.cells)
        ? {
            rows: graph.rows,
            cols: graph.cols,
            cells: input.mask.cells.map(Boolean),
          }
        : (input.mask as boolean[] | boolean[][])
      mask = normalizeMask(graph.rows, graph.cols, candidate)
    } catch {
      mask = graphToMask(graph)
    }
  }

  return {
    ...fallback,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: safeString(input.appVersion, CURRENT_APP_VERSION, 64),
    id: safeId(input.id, createProjectId()),
    title: safeString(input.title, fallback.title, 200),
    description: safeString(input.description, '', 20_000),
    creatorDisplayName: safeString(input.creatorDisplayName, '', 120),
    createdAt: safeIsoDate(input.createdAt, now),
    updatedAt: safeIsoDate(input.updatedAt, now),
    seed: graph.seed,
    canvas,
    grid: {
      rows: graph.rows,
      cols: graph.cols,
      minimumCellPixels: isRecord(input.grid)
        ? boundedNumber(input.grid.minimumCellPixels, 8, 1, 100)
        : 8,
    },
    shape: normalizeShape(input.shape, fallback.shape),
    mask,
    mazeGraph: graph,
    startCell: start,
    endCell: end,
    difficulty,
    mazeMetrics: calculateMazeMetrics(graph, start, end),
    visualTheme: normalizeTheme(input.visualTheme, fallback.visualTheme),
    background: normalizeBackground(input.background, fallback.background),
    gameRules: normalizeRules(input.gameRules, fallback.gameRules),
    collectibles: normalizeItems(input.collectibles, graph),
    checkpoints: normalizeItems(input.checkpoints, graph),
    secretReveal: normalizeSecret(input.secretReveal, fallback.secretReveal),
    creatorReplay: normalizeReplay(input.creatorReplay, graph),
    exportSettings: normalizeExport(input.exportSettings, fallback.exportSettings),
    attribution: normalizeAttribution(input.attribution ?? input.remixSource),
    remixAllowed:
      input.remixAllowed === undefined ? true : Boolean(input.remixAllowed),
  }
}

export function serializeProject(project: MazeProject, pretty = false): string {
  const normalized = migrateProject(project)
  normalized.updatedAt = project.updatedAt
  return JSON.stringify(normalized, null, pretty ? 2 : undefined)
}

export function deserializeProject(
  text: string,
  options: { maximumBytes?: number } = {},
): MazeProject {
  const maximumBytes = options.maximumBytes ?? DEFAULT_IMPORT_LIMIT_BYTES
  const byteLength = new TextEncoder().encode(text).byteLength
  if (byteLength > maximumBytes) {
    throw new ProjectImportError(
      'file-too-large',
      `프로젝트 파일이 허용 크기(${maximumBytes}바이트)를 초과했습니다.`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new ProjectImportError('invalid-json', '프로젝트 JSON을 읽을 수 없습니다.')
  }
  return migrateProject(parsed)
}
