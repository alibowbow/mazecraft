import { createDrawingMask } from '../core/masks/drawingMask'
import { createImageMask, DEFAULT_IMAGE_OPTIONS } from '../core/masks/imageMask'
import { createShapeMask } from '../core/masks/shapeMask'
import { createTextMask } from '../core/masks/textMask'
import type { BooleanMask } from '../core/masks/types'
import {
  createDefaultProject,
  generateBestMazeCandidate,
  type DifficultyLevel,
  type MazeCandidate,
  type MazeMask,
  type MazeProject,
} from '../core/maze'
import type { ProjectTemplate } from '../features/home/HomeScreen'

const randomSeed = () =>
  typeof crypto !== 'undefined' && 'getRandomValues' in crypto
    ? [...crypto.getRandomValues(new Uint32Array(2))].map((value) => value.toString(36)).join('-')
    : `maze-${Date.now().toString(36)}`

const matrixToMask = (matrix: BooleanMask): MazeMask => ({
  rows: matrix.length,
  cols: matrix[0]?.length ?? 0,
  cells: matrix.flat(),
})

const defaultTextSettings = {
  text: '꿈',
  mode: 'outline' as const,
  fontFamily: 'system-ui, sans-serif',
  fontWeight: 800,
  letterSpacing: 0,
  lineHeight: 1.1,
  horizontalAlign: 'center' as const,
  verticalAlign: 'middle' as const,
  autoFit: true,
}

export const createProjectFromTemplate = (template: ProjectTemplate): MazeProject => {
  const seed = randomSeed()
  const common = { seed }
  if (template === 'text') {
    const base = createDefaultProject({ ...common, title: '글자 미로', grid: { rows: 32, cols: 32, minimumCellPixels: 8 } })
    return regenerateProjectSync({
      ...base,
      shape: { kind: 'text', settings: defaultTextSettings },
    })
  }
  if (template === 'image') {
    return createDefaultProject({ ...common, title: '이미지 실루엣 미로' })
  }
  if (template === 'secret') {
    return createDefaultProject({
      ...common,
      title: '시크릿 메시지 미로',
      secretReveal: {
        content: { kind: 'message', message: '여기에 완주 후 공개할 이야기를 적어보세요.' },
        mode: 'on-complete',
        animation: 'fade',
      },
    })
  }
  if (template === 'time-attack') {
    return createDefaultProject({
      ...common,
      title: '타임어택 챌린지',
      difficulty: 'hard',
      grid: { rows: 34, cols: 34, minimumCellPixels: 7 },
      gameRules: {
        mode: 'time-attack',
        timeLimitSeconds: 120,
        allowedHints: 2,
        showDpad: true,
        soundEnabled: true,
        ghostAllowed: true,
      },
    })
  }
  if (template === 'worksheet') {
    return createDefaultProject({
      ...common,
      title: '인쇄용 미로',
      canvas: { width: 1240, height: 1754, aspectRatio: 'a4-portrait' },
      background: { kind: 'solid', color: '#ffffff' },
      visualTheme: {
        wallColor: '#111111',
        pathColor: '#ffffff',
        startColor: '#0b6b52',
        endColor: '#c43b35',
        accentColor: '#2c65ad',
        wallWidth: 2,
        cornerRadius: 0,
      },
    })
  }
  return createDefaultProject({ ...common, title: '새 미로' })
}

export const createProjectMask = (project: MazeProject): MazeMask => {
  const { rows, cols } = project.grid
  if (project.shape.kind === 'basic') {
    return matrixToMask(createShapeMask(project.shape.name, rows, cols))
  }
  if (project.shape.kind === 'text') {
    const settings = project.shape.settings
    return matrixToMask(
      createTextMask(
        {
          text: settings.text,
          mode: settings.mode === 'secret' ? 'reveal' : settings.mode,
          fontFamily: settings.fontFamily,
          fontWeight: settings.fontWeight,
          letterSpacing: settings.letterSpacing,
          lineHeight: settings.lineHeight,
          align: settings.horizontalAlign,
          verticalAlign: settings.verticalAlign,
          fit: settings.autoFit ? 'contain' : 'manual',
        },
        rows,
        cols,
      ),
    )
  }
  if (project.shape.kind === 'drawing') {
    return matrixToMask(createDrawingMask(project.shape.paths, rows, cols, project.shape.brushSize))
  }
  return project.mask.rows === rows && project.mask.cols === cols
    ? project.mask
    : matrixToMask(createShapeMask('rectangle', rows, cols))
}

export const regenerateProjectSync = (
  project: MazeProject,
  onProgress?: (completed: number, total: number) => void,
): MazeProject => {
  const mask = createProjectMask(project)
  const candidate = generateBestMazeCandidate(
    {
      rows: project.grid.rows,
      cols: project.grid.cols,
      seed: project.seed,
      difficulty: project.difficulty,
      algorithm: project.mazeGraph.algorithm,
      mask,
      minimumPassageWidth: project.grid.minimumCellPixels,
    },
    { onProgress: (progress) => onProgress?.(progress.completed, progress.total) },
  )
  return applyMazeCandidate(project, mask, candidate)
}

export const applyMazeCandidate = (
  project: MazeProject,
  mask: MazeMask,
  candidate: MazeCandidate,
): MazeProject => {
  const now = new Date().toISOString()
  return {
    ...project,
    updatedAt: now,
    seed: project.seed,
    mask,
    mazeGraph: candidate.result.graph,
    startCell: candidate.result.start,
    endCell: candidate.result.end,
    mazeMetrics: candidate.result.metrics,
    creatorReplay: null,
    collectibles: project.collectibles.filter((item) => candidate.result.graph.cells[item.row * candidate.result.graph.cols + item.col]?.active),
    checkpoints: project.checkpoints.filter((item) => candidate.result.graph.cells[item.row * candidate.result.graph.cols + item.col]?.active),
  }
}

const imageFromDataUrl = (dataUrl: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('이미지 미리보기를 만들 수 없습니다.'))
    image.src = dataUrl
  })

export const prepareImageMaskProject = async (project: MazeProject): Promise<MazeProject> => {
  if (project.shape.kind !== 'image') return project
  const settings = project.shape.settings
  const image = await imageFromDataUrl(settings.dataUrl)
  const matrix = createImageMask(
    image,
    {
      ...DEFAULT_IMAGE_OPTIONS,
      scale:
        settings.scale /
        Math.max(0.1, Math.min(settings.crop.width, settings.crop.height)),
      rotation: settings.rotation,
      grayscale: settings.grayscale,
      threshold: settings.threshold,
      invert: settings.inverted,
      smoothing: settings.smoothing,
      noiseSize: settings.noiseRemoval,
      fillInterior: settings.fillInterior,
      largestComponentOnly: settings.largestComponentOnly,
      offsetX: settings.crop.x,
      offsetY: settings.crop.y,
    },
    project.grid.rows,
    project.grid.cols,
  )
  return { ...project, mask: matrixToMask(matrix) }
}

export const regenerateImageProject = async (project: MazeProject): Promise<MazeProject> =>
  regenerateProjectSync(await prepareImageMaskProject(project))

export const difficultyLabel = (difficulty: DifficultyLevel) =>
  ({
    'very-easy': '매우 쉬움',
    easy: '쉬움',
    normal: '보통',
    hard: '어려움',
    expert: '전문가',
    custom: '사용자 지정',
  })[difficulty]

export const scoreLabel = (score: number) =>
  score < 25 ? '매우 쉬움' : score < 42 ? '쉬움' : score < 64 ? '보통' : score < 82 ? '어려움' : '전문가'
