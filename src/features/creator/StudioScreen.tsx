import {
  ArrowLeftRight,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Cloud,
  Crown,
  Diamond,
  Download,
  Droplets,
  Eraser,
  FileImage,
  Flower2,
  Gamepad2,
  Grid2X2,
  Heart,
  Hexagon,
  House,
  Image as ImageIcon,
  Layers3,
  Lightbulb,
  Maximize2,
  MessageCircle,
  Minimize2,
  Minus,
  Moon,
  Move,
  PanelRightClose,
  PanelRightOpen,
  Paintbrush,
  PencilLine,
  Play,
  Plus,
  Puzzle,
  Redo2,
  RotateCw,
  Scan,
  Settings2,
  Share2,
  ShieldCheck,
  Sparkles,
  Square,
  Star,
  Sun,
  TreePine,
  Undo2,
  Upload,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { MazeCanvas, type MazeCanvasHandle, type MazeEditGesture } from '../../components/MazeCanvas'
import { SHAPE_LABELS, type BuiltInShape } from '../../core/masks/types'
import {
  UndoRedoHistory,
  calculateMazeMetrics,
  cloneMazeGraph,
  graphToMask,
  optimizeEndpoints,
  repairMaze,
  setWall,
  solveMaze,
  swapEndpoints,
  transformMaze,
  validateMaze,
  type CellPosition,
  type DifficultyLevel,
  type MazeAlgorithm,
  type MazeGenerationTraceStep,
  type MazeProject,
  type MazeValidationResult,
} from '../../core/maze'
import type { AppState } from '../../app/stateMachine'
import {
  MazeAnimationController,
  animationSnapshotToRenderFrame,
  type MazeAnimationSnapshot,
} from '../../renderer/animationController'
import { renderModelFromProject } from '../../renderer/types'
import { createRandomSeed, difficultyLabel, scoreLabel } from '../../app/projectFactory'
import type { AutosaveStatus } from '../../storage'
import { type EditorTool } from '../editor/editor'

const WaterSimulationDialog = lazy(
  () => import('../waterSimulation/WaterSimulationDialog'),
)

export type StudioStep = 1 | 2 | 3 | 4 | 5 | 6

interface StudioScreenProps {
  project: MazeProject
  state: AppState
  saveStatus: AutosaveStatus
  generationProgress: { completed: number; total: number } | null
  generationTrace: MazeGenerationTraceStep[]
  onChange: (project: MazeProject) => void
  onGenerate: (base?: MazeProject) => Promise<boolean>
  onCancelGeneration: () => void
  onPlay: (recordCreator?: boolean) => void
  onHome: () => void
  onShare: () => void
  onExport: () => void
  onThemeToggle: () => void
  dark: boolean
  onToast: (message: string, error?: boolean) => void
}

const steps: Array<{ id: StudioStep; title: string; hint: string; icon: typeof Grid2X2 }> = [
  { id: 1, title: '형태', hint: '윤곽과 입력 소스', icon: Grid2X2 },
  { id: 2, title: '미로', hint: '난이도와 벽 편집', icon: Layers3 },
  { id: 3, title: '게임', hint: '규칙과 시크릿', icon: Gamepad2 },
  { id: 4, title: '꾸미기', hint: '색상과 배경', icon: Paintbrush },
  { id: 5, title: '테스트', hint: '검증과 플레이', icon: ShieldCheck },
  { id: 6, title: '공유', hint: '링크와 파일', icon: Share2 },
]

const mobileSteps: StudioStep[] = [1, 2, 3, 4, 5, 6]
const compactLayoutQuery = '(max-width: 1180px)'

const shapeIcons: Record<BuiltInShape, typeof Square> = {
  rectangle: Square,
  'rounded-rectangle': Square,
  circle: CircleDot,
  ellipse: CircleDot,
  heart: Heart,
  star: Star,
  diamond: Diamond,
  hexagon: Hexagon,
  crescent: Moon,
  cloud: Cloud,
  flower: Flower2,
  tree: TreePine,
  house: House,
  crown: Crown,
  lightning: Zap,
  'speech-bubble': MessageCircle,
  puzzle: Puzzle,
}

const difficultyOptions: DifficultyLevel[] = ['very-easy', 'easy', 'normal', 'hard', 'expert', 'custom']

const toolOptions: Array<{ id: EditorTool; label: string; icon: (props: { size?: number }) => ReactNode }> = [
  { id: 'open-wall', label: '벽 열기', icon: Minus },
  { id: 'close-wall', label: '벽 닫기', icon: Plus },
  { id: 'set-start', label: '시작점', icon: CircleDot },
  { id: 'set-end', label: '종료점', icon: Sparkles },
  { id: 'collectible', label: '수집 아이템', icon: Star },
  { id: 'checkpoint', label: '체크포인트', icon: FlagIcon },
  { id: 'eraser', label: '지우개', icon: Eraser },
  { id: 'pan', label: '이동', icon: Move },
]

const clampGridSize = (raw: string, fallback: number) => {
  if (!raw.trim()) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(8, Math.min(150, Math.round(parsed)))
}

function FlagIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 21V4m0 1h11l-2 4 2 4H5" /></svg>
}

const inputSource = (project: MazeProject) =>
  project.shape.kind === 'basic' ? 'shape' : project.shape.kind

const projectWithMetrics = (project: MazeProject): MazeProject => ({
  ...project,
  updatedAt: new Date().toISOString(),
  mask: graphToMask(project.mazeGraph),
  mazeMetrics: calculateMazeMetrics(project.mazeGraph, project.startCell, project.endCell),
})

type EditorSnapshot = Pick<
  MazeProject,
  'mazeGraph' | 'startCell' | 'endCell' | 'collectibles' | 'checkpoints'
>

const editorSnapshotFromProject = (project: MazeProject): EditorSnapshot => ({
  mazeGraph: project.mazeGraph,
  startCell: project.startCell,
  endCell: project.endCell,
  collectibles: project.collectibles,
  checkpoints: project.checkpoints,
})

const projectFromEditorSnapshot = (
  project: MazeProject,
  snapshot: EditorSnapshot,
): MazeProject => projectWithMetrics({
  ...project,
  ...snapshot,
  grid: {
    ...project.grid,
    rows: snapshot.mazeGraph.rows,
    cols: snapshot.mazeGraph.cols,
  },
})

const fileToDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('파일을 읽을 수 없습니다.'))
    reader.readAsDataURL(file)
  })

const sanitizeSvg = async (file: Blob) => {
  const text = await file.text()
  const documentNode = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (
    documentNode.querySelector('parsererror') ||
    documentNode.documentElement.localName.toLowerCase() !== 'svg'
  ) {
    throw new Error('SVG 형식이 올바르지 않습니다.')
  }
  documentNode
    .querySelectorAll(
      'script, style, foreignObject, iframe, object, embed, audio, video, link, meta, animate, animateMotion, animateTransform, set, discard',
    )
    .forEach((node) => node.remove())
  documentNode.querySelectorAll('*').forEach((node) => {
    ;[...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      const isReference = name === 'href' || name === 'xlink:href' || name === 'src'
      const unsafeReference =
        isReference &&
        !/^#[A-Za-z_][\w:.-]*$/.test(value) &&
        !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(value)
      const unsafePaint = [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].some(
        (match) => !/^#[A-Za-z_][\w:.-]*$/.test(match[2].trim()),
      )
      if (
        name.startsWith('on') ||
        name === 'style' ||
        name === 'xml:base' ||
        unsafeReference ||
        unsafePaint ||
        value.includes('\\') ||
        /(?:javascript\s*:|@import\b|expression\s*\(|behavior\s*:|-moz-binding)/i.test(
          value,
        )
      ) {
        node.removeAttribute(attribute.name)
      }
    })
  })
  const serialized = new XMLSerializer().serializeToString(documentNode.documentElement)
  const bytes = new TextEncoder().encode(serialized)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

const resizeImage = async (file: File) => {
  if (file.type === 'image/svg+xml') return sanitizeSvg(file)
  const original = await fileToDataUrl(file)
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('이미지를 해석할 수 없습니다.'))
    element.src = original
  })
  const maximum = 1280
  const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/webp', 0.84)
}

export function StudioScreen({
  project,
  state,
  saveStatus,
  generationProgress,
  generationTrace,
  onChange,
  onGenerate,
  onCancelGeneration,
  onPlay,
  onHome,
  onShare,
  onExport,
  onThemeToggle,
  dark,
  onToast,
}: StudioScreenProps) {
  const [step, setStep] = useState<StudioStep>(1)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editorEnabled, setEditorEnabled] = useState(false)
  const [tool, setTool] = useState<EditorTool>('open-wall')
  const [mazePanelMode, setMazePanelMode] = useState<'generate' | 'edit'>('generate')
  const [gridDraft, setGridDraft] = useState({
    cols: String(project.grid.cols),
    rows: String(project.grid.rows),
  })
  const [seedDraft, setSeedDraft] = useState('')
  const [selectedCell, setSelectedCell] = useState<CellPosition | null>(null)
  const [showSolution, setShowSolution] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [source, setSource] = useState<'shape' | 'text' | 'image' | 'drawing'>(inputSource(project))
  const [animationMode, setAnimationMode] = useState<'path' | 'water' | 'particle'>('path')
  const [effectQuality, setEffectQuality] = useState<'auto' | 'low' | 'high'>('auto')
  const [generationAnimation, setGenerationAnimation] = useState<'none' | MazeAlgorithm>(
    project.mazeGraph.algorithm,
  )
  const [generationTraceProgress, setGenerationTraceProgress] = useState<number | null>(null)
  const [particleDensity, setParticleDensity] = useState(4)
  const [animation, setAnimation] = useState<MazeAnimationSnapshot | null>(null)
  const [waterSimulationOpen, setWaterSimulationOpen] = useState(false)
  const [waterSimulationProject, setWaterSimulationProject] =
    useState<MazeProject | null>(null)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [compactLayout, setCompactLayout] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(compactLayoutQuery).matches,
  )
  const canvasRef = useRef<MazeCanvasHandle>(null)
  const historyRef = useRef(new UndoRedoHistory(editorSnapshotFromProject(project), 100))
  const editBaselineRef = useRef(editorSnapshotFromProject(project))
  const historyProjectIdRef = useRef(project.id)
  const acknowledgedEditorGraphRef = useRef(project.mazeGraph)
  const wallEditRef = useRef<{
    gestureId: number
    baseline: MazeProject
    graph: ReturnType<typeof cloneMazeGraph>
    changed: boolean
  } | null>(null)
  const drawingPathRef = useRef<Array<{ x: number; y: number; pressure: number }>>([])
  const sheetStartRef = useRef<number | null>(null)
  const sheetCloseRef = useRef<HTMLButtonElement>(null)
  const sheetReturnFocusRef = useRef<HTMLElement | null>(null)
  const sheetWasOpenRef = useRef(false)
  const solution = useMemo(
    () => solveMaze(project.mazeGraph, project.startCell, project.endCell).path,
    [project.mazeGraph, project.startCell, project.endCell],
  )
  const canvasModel = useMemo(
    () => renderModelFromProject(project),
    [project],
  )
  const lowPowerDevice = useMemo(() => {
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    return navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory <= 4)
  }, [])
  const validation = useMemo(
    () => validateMaze(project.mazeGraph, project.startCell, project.endCell, {
      minimumPassageWidth: project.grid.minimumCellPixels,
    }),
    [project],
  )
  const controllerRef = useRef<MazeAnimationController | null>(null)

  useEffect(() => {
    setGridDraft({ cols: String(project.grid.cols), rows: String(project.grid.rows) })
  }, [project.id, project.grid.cols, project.grid.rows])

  useEffect(() => {
    setSeedDraft('')
  }, [project.id])

  useEffect(() => {
    const query = window.matchMedia(compactLayoutQuery)
    const updateLayout = () => {
      setCompactLayout(query.matches)
      if (!query.matches) setSheetOpen(false)
    }
    updateLayout()
    query.addEventListener('change', updateLayout)
    return () => query.removeEventListener('change', updateLayout)
  }, [])

  useEffect(() => {
    let frameId = 0
    const open = compactLayout && sheetOpen
    if (open) {
      frameId = requestAnimationFrame(() => sheetCloseRef.current?.focus())
    } else if (sheetWasOpenRef.current) {
      frameId = requestAnimationFrame(() => sheetReturnFocusRef.current?.focus())
    }
    sheetWasOpenRef.current = open
    return () => cancelAnimationFrame(frameId)
  }, [compactLayout, sheetOpen])

  useEffect(() => {
    controllerRef.current = new MazeAnimationController({ onFrame: setAnimation })
    return () => controllerRef.current?.dispose()
  }, [])

  useEffect(() => {
    if (
      generationAnimation === 'none' ||
      generationTrace.length === 0 ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setGenerationTraceProgress(null)
      return
    }
    let frameId = 0
    let clearId = 0
    const startedAt = performance.now()
    const duration = Math.max(600, Math.min(2_200, generationTrace.length * 1.4))
    setGenerationTraceProgress(0)
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      setGenerationTraceProgress(progress)
      if (progress < 1) {
        frameId = requestAnimationFrame(tick)
      } else {
        clearId = window.setTimeout(() => setGenerationTraceProgress(null), 180)
      }
    }
    frameId = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frameId)
      window.clearTimeout(clearId)
    }
  }, [generationAnimation, generationTrace])

  useEffect(() => {
    setGenerationAnimation(project.mazeGraph.algorithm)
  }, [project.id])

  useEffect(() => {
    controllerRef.current?.cancel()
    setShowSolution(false)
    setAnimation(null)
  }, [solution])

  useEffect(() => {
    if (state !== 'generating') return
    controllerRef.current?.cancel()
    setShowSolution(false)
    setAnimation(null)
    setWaterSimulationOpen(false)
    setWaterSimulationProject(null)
  }, [state])

  useEffect(() => {
    const switchedProject = historyProjectIdRef.current !== project.id
    const externalGraphChange = acknowledgedEditorGraphRef.current !== project.mazeGraph
    controllerRef.current?.cancel()
    if (switchedProject || externalGraphChange) {
      historyRef.current = new UndoRedoHistory(editorSnapshotFromProject(project), 100)
      editBaselineRef.current = editorSnapshotFromProject(project)
      wallEditRef.current = null
    }
    historyProjectIdRef.current = project.id
    acknowledgedEditorGraphRef.current = project.mazeGraph
    setSource(inputSource(project))
    setShowSolution(false)
    setAnimation(null)
    setWaterSimulationOpen(false)
    setWaterSimulationProject(null)
  }, [project.id, project.mazeGraph])

  const commit = useCallback(
    (next: MazeProject) => {
      const withMetrics = projectWithMetrics(next)
      acknowledgedEditorGraphRef.current = withMetrics.mazeGraph
      historyRef.current.push(editorSnapshotFromProject(withMetrics))
      onChange(withMetrics)
    },
    [onChange],
  )

  const update = <K extends keyof MazeProject>(key: K, value: MazeProject[K]) => {
    onChange({ ...project, [key]: value, updatedAt: new Date().toISOString() })
  }

  const updateImageSettings = (
    patch: Partial<Extract<MazeProject['shape'], { kind: 'image' }>['settings']>,
  ) => {
    if (project.shape.kind !== 'image') return
    onChange({
      ...project,
      shape: {
        ...project.shape,
        settings: { ...project.shape.settings, ...patch },
      },
    })
  }

  const updateImageCrop = (
    patch: Partial<Extract<MazeProject['shape'], { kind: 'image' }>['settings']['crop']>,
  ) => {
    if (project.shape.kind !== 'image') return
    updateImageSettings({ crop: { ...project.shape.settings.crop, ...patch } })
  }

  const selectStep = (next: StudioStep, openSheet = false, trigger?: HTMLElement) => {
    if (next !== 2 && !(next === 1 && source === 'drawing')) {
      finishWallEdit(true)
      setEditorEnabled(false)
    }
    setStep(next)
    setInspectorCollapsed(false)
    setFocusMode(false)
    if (openSheet && compactLayout) {
      sheetReturnFocusRef.current = trigger ?? (document.activeElement as HTMLElement | null)
      setSheetOpen(true)
    }
  }

  const toggleInspectorPanel = (trigger: HTMLButtonElement) => {
    if (compactLayout) {
      setInspectorCollapsed(false)
      if (sheetOpen) {
        setSheetOpen(false)
      } else {
        sheetReturnFocusRef.current = trigger
        setSheetOpen(true)
      }
      return
    }
    setInspectorCollapsed((value) => !value)
  }

  const toggleFocusMode = () => {
    setFocusMode((value) => !value)
    setSheetOpen(false)
  }

  const inspectorPanelOpen = compactLayout ? sheetOpen : !inspectorCollapsed

  const projectFromGridDraft = () => {
    const cols = clampGridSize(gridDraft.cols, project.grid.cols)
    const rows = clampGridSize(gridDraft.rows, project.grid.rows)
    const next = {
      ...project,
      grid: { ...project.grid, cols, rows },
      updatedAt: new Date().toISOString(),
    }
    setGridDraft({ cols: String(cols), rows: String(rows) })
    return next
  }

  const setGridPreset = (cols: number, rows: number) => {
    setGridDraft({ cols: String(cols), rows: String(rows) })
  }

  const generateMazeFromDraft = async () => {
    const requestedSeed = seedDraft.trim()
    const next = {
      ...projectFromGridDraft(),
      seed: requestedSeed || createRandomSeed(),
      updatedAt: new Date().toISOString(),
    }
    if (await onGenerate(next)) setSeedDraft('')
  }

  const fitAndFocusCanvas = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        canvasRef.current?.fit()
        canvasRef.current?.getCanvas()?.focus({ preventScroll: true })
      })
    })
  }

  const chooseEditorTool = (nextTool: EditorTool) => {
    finishWallEdit(true)
    if (!editorEnabled) editBaselineRef.current = editorSnapshotFromProject(project)
    setEditorEnabled(true)
    setMazePanelMode('edit')
    setStep(2)
    setTool(nextTool)
    if (compactLayout) setSheetOpen(false)
    fitAndFocusCanvas()
  }

  const toggleEditor = () => {
    if (editorEnabled) {
      finishWallEdit(true)
      setEditorEnabled(false)
      return
    }
    editBaselineRef.current = editorSnapshotFromProject(project)
    setStep(2)
    setMazePanelMode('edit')
    setSheetOpen(false)
    setEditorEnabled(true)
    fitAndFocusCanvas()
  }

  const previewWallGraph = (base: MazeProject, graph: ReturnType<typeof cloneMazeGraph>) => {
    const renderer = canvasRef.current?.getRenderer()
    if (!renderer) return
    renderer.setModel(renderModelFromProject({ ...base, mazeGraph: graph }))
    renderer.invalidateStaticLayer()
    canvasRef.current?.draw()
  }

  const finishWallEdit = (save: boolean, gestureId?: number) => {
    const transaction = wallEditRef.current
    if (gestureId !== undefined && transaction?.gestureId !== gestureId) return
    wallEditRef.current = null
    if (!transaction) return
    if (save && transaction.changed) {
      commit({ ...project, mazeGraph: transaction.graph })
    } else {
      previewWallGraph(project, transaction.baseline.mazeGraph)
    }
  }

  const restoreEditorHistory = (direction: 'undo' | 'redo') => {
    finishWallEdit(true)
    const snapshot = direction === 'undo'
      ? historyRef.current.undo()
      : historyRef.current.redo()
    const next = projectFromEditorSnapshot(project, snapshot)
    acknowledgedEditorGraphRef.current = next.mazeGraph
    onChange(next)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]')
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        if (typing) return
        event.preventDefault()
        restoreEditorHistory(event.shiftKey ? 'redo' : 'undo')
      } else if (event.key === 'Delete' && selectedCell && !typing) {
        event.preventDefault()
        commit({
          ...project,
          collectibles: project.collectibles.filter((item) => item.row !== selectedCell.row || item.col !== selectedCell.col),
          checkpoints: project.checkpoints.filter((item) => item.row !== selectedCell.row || item.col !== selectedCell.col),
        })
      } else if (event.key === 'Escape') {
        finishWallEdit(true)
        setSheetOpen(false)
        setFocusMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commit, project, restoreEditorHistory, selectedCell])

  const handleEditGesture = (gesture: MazeEditGesture) => {
    if (step === 1 && source === 'drawing') {
      if (gesture.phase === 'cancel') {
        drawingPathRef.current = []
        return
      }
      if (gesture.phase === 'start') drawingPathRef.current = []
      if (gesture.phase !== 'end' && gesture.hit) {
        drawingPathRef.current.push({
          x: Math.max(0, Math.min(1, gesture.hit.x / project.grid.cols)),
          y: Math.max(0, Math.min(1, gesture.hit.y / project.grid.rows)),
          pressure: gesture.originalEvent.pressure || 1,
        })
      }
      if (gesture.phase === 'end' && drawingPathRef.current.length) {
        const existing = project.shape.kind === 'drawing' ? project.shape.paths : []
        const next: MazeProject = {
          ...project,
          shape: {
            kind: 'drawing',
            paths: [...existing, drawingPathRef.current],
            brushSize: project.shape.kind === 'drawing' ? project.shape.brushSize : 0.045,
          },
        }
        drawingPathRef.current = []
        void onGenerate(next)
      }
      return
    }

    if (editorEnabled && step === 2 && (tool === 'open-wall' || tool === 'close-wall')) {
      if (gesture.phase === 'cancel') {
        finishWallEdit(false, gesture.gestureId)
        return
      }
      if (gesture.phase === 'end') {
        finishWallEdit(true, gesture.gestureId)
        return
      }
      if (gesture.hit?.kind !== 'wall') return
      let transaction = wallEditRef.current
      if (!transaction || transaction.gestureId !== gesture.gestureId) {
        const baseline = transaction?.changed
          ? { ...project, mazeGraph: transaction.graph }
          : project
        if (transaction) finishWallEdit(true, transaction.gestureId)
        transaction = {
          gestureId: gesture.gestureId,
          baseline,
          graph: cloneMazeGraph(baseline.mazeGraph),
          changed: false,
        }
        wallEditRef.current = transaction
      }
      const cell = transaction.graph.cells[
        gesture.hit.row * transaction.graph.cols + gesture.hit.col
      ]
      const desiredClosed = tool === 'close-wall'
      if (!cell || cell.walls[gesture.hit.wall] === desiredClosed) return
      setWall(
        transaction.graph,
        { row: gesture.hit.row, col: gesture.hit.col },
        gesture.hit.wall,
        desiredClosed,
      )
      const updatedCell = transaction.graph.cells[
        gesture.hit.row * transaction.graph.cols + gesture.hit.col
      ]
      if (updatedCell?.walls[gesture.hit.wall] !== desiredClosed) return
      transaction.changed = true
      previewWallGraph(transaction.baseline, transaction.graph)
      return
    }

    if (gesture.phase === 'cancel') return
    const hit = gesture.hit
    if (!hit) return
    setSelectedCell({ row: hit.row, col: hit.col })

    if (gesture.phase !== 'start' || hit.kind !== 'cell') return
    const position = { row: hit.row, col: hit.col }
    if (tool === 'set-start') commit({ ...project, startCell: position })
    else if (tool === 'set-end') commit({ ...project, endCell: position })
    else if (tool === 'collectible') {
      const exists = project.collectibles.some((item) => item.row === position.row && item.col === position.col)
      if (!exists) commit({ ...project, collectibles: [...project.collectibles, { ...position, id: crypto.randomUUID(), label: '수집 아이템' }] })
    } else if (tool === 'checkpoint') {
      const exists = project.checkpoints.some((item) => item.row === position.row && item.col === position.col)
      if (!exists) commit({ ...project, checkpoints: [...project.checkpoints, { ...position, id: crypto.randomUUID(), label: `체크포인트 ${project.checkpoints.length + 1}` }] })
    } else if (tool === 'eraser') {
      commit({
        ...project,
        collectibles: project.collectibles.filter((item) => item.row !== position.row || item.col !== position.col),
        checkpoints: project.checkpoints.filter((item) => item.row !== position.row || item.col !== position.col),
      })
    }
  }

  const applyTransform = (operation: 'flip-horizontal' | 'flip-vertical' | 'rotate-clockwise') => {
    const result = transformMaze(project.mazeGraph, operation, project.startCell, project.endCell)
    commit({
      ...project,
      mazeGraph: result.graph,
      startCell: result.start!,
      endCell: result.end!,
      grid: { ...project.grid, rows: result.graph.rows, cols: result.graph.cols },
    })
  }

  const autoRepair = () => {
    const repaired = repairMaze(project.mazeGraph, project.startCell, project.endCell, {
      minimumPassageWidth: project.grid.minimumCellPixels,
    })
    commit({
      ...project,
      mazeGraph: repaired.graph,
      startCell: repaired.start,
      endCell: repaired.end,
      mazeMetrics: repaired.validation.metrics,
    })
    onToast(repaired.repairs.length ? `${repaired.repairs.length}가지 문제를 복구했습니다.` : '복구할 문제가 없습니다.')
  }

  const chooseShape = (name: BuiltInShape) => {
    const next = { ...project, shape: { kind: 'basic' as const, name, inset: 0 } }
    setSource('shape')
    void onGenerate(next)
  }

  const handleImage = async (file?: File) => {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      onToast('JPG, PNG, WEBP, SVG 이미지만 사용할 수 있습니다.', true)
      return
    }
    if (file.size > 12 * 1024 * 1024) {
      onToast('이미지는 12MB 이하만 사용할 수 있습니다.', true)
      return
    }
    try {
      const dataUrl = await resizeImage(file)
      const next: MazeProject = {
        ...project,
        shape: {
          kind: 'image',
          settings: {
            mediaType: file.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml',
            dataUrl,
            crop: { x: 0, y: 0, width: 1, height: 1 },
            scale: 0.92,
            rotation: 0,
            grayscale: true,
            threshold: 170,
            inverted: false,
            smoothing: 2,
            noiseRemoval: 3,
            fillInterior: true,
            largestComponentOnly: true,
          },
        },
      }
      setSource('image')
      await onGenerate(next)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '이미지를 처리할 수 없습니다.', true)
    }
  }

  const playSolveAnimation = async (
    mode: 'path' | 'water' | 'particle' = animationMode,
  ) => {
    controllerRef.current?.cancel()
    setAnimation(null)
    setShowSolution(mode === 'path')
    const reduceEffects =
      effectQuality === 'low' || (effectQuality === 'auto' && lowPowerDevice)
    await controllerRef.current?.play({
      mode,
      path: solution,
      density: reduceEffects ? Math.min(3, particleDensity) : particleDensity,
      color: project.visualTheme.accentColor,
    })
  }

  const toggleSolutionPath = () => {
    if (showSolution) {
      controllerRef.current?.cancel()
      setShowSolution(false)
      setAnimation(null)
      return
    }
    void playSolveAnimation('path')
  }

  const openWaterSimulation = () => {
    controllerRef.current?.cancel()
    setShowSolution(false)
    setAnimation(null)
    setSheetOpen(false)

    const endpoints = optimizeEndpoints(project.mazeGraph)
    const reoriented =
      endpoints.start.row !== project.startCell.row ||
      endpoints.start.col !== project.startCell.col ||
      endpoints.end.row !== project.endCell.row ||
      endpoints.end.col !== project.endCell.col
    const simulationProject = reoriented
      ? projectWithMetrics({
          ...project,
          startCell: endpoints.start,
          endCell: endpoints.end,
          creatorReplay: null,
        })
      : project

    if (reoriented) {
      commit(simulationProject)
      onToast('물 흐름에 맞춰 입구를 최상단, 출구를 최하단으로 재배치했습니다.')
    }
    setWaterSimulationProject(simulationProject)
    setWaterSimulationOpen(true)
  }

  const history = historyRef.current.state
  const rendererFrame = showSolution
    ? {
        solution,
        solutionProgress:
          animation?.mode === 'path' ? animation.solutionProgress : 0,
      }
    : animation
      ? animationSnapshotToRenderFrame(animation)
      : generationTraceProgress !== null
        ? {
            generation: {
              edges: generationTrace,
              progress: generationTraceProgress,
              color: project.visualTheme.accentColor,
            },
          }
      : {}

  const inspectorContent = (() => {
    if (step === 1) {
      return (
        <>
          <div className="inspector-section settings-stack">
            <div className="segmented">
              {([
                ['shape', '도형'],
                ['text', '텍스트'],
                ['image', '이미지'],
                ['drawing', '그리기'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  className={source === value ? 'active' : ''}
                  onClick={() => {
                    finishWallEdit(true)
                    setSource(value)
                    if (value === 'drawing') {
                      if (project.shape.kind !== 'drawing') {
                        onChange({ ...project, shape: { kind: 'drawing', paths: [], brushSize: 0.045 } })
                      }
                      setEditorEnabled(true)
                      if (compactLayout) {
                        setSheetOpen(false)
                        fitAndFocusCanvas()
                      }
                    } else {
                      setEditorEnabled(false)
                    }
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {source === 'shape' && (
              <div className="shape-grid">
                {(Object.keys(SHAPE_LABELS) as BuiltInShape[]).map((name) => {
                  const Icon = shapeIcons[name]
                  return (
                    <button key={name} className={`shape-button ${project.shape.kind === 'basic' && project.shape.name === name ? 'active' : ''}`} onClick={() => chooseShape(name)}>
                      <Icon size={18} />
                      <span>{SHAPE_LABELS[name]}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {source === 'text' && (
              <>
                <label className="field"><span>텍스트</span><textarea value={project.shape.kind === 'text' ? project.shape.settings.text : '꿈'} onChange={(event) => onChange({ ...project, shape: { kind: 'text', settings: { ...(project.shape.kind === 'text' ? project.shape.settings : { text: '', mode: 'outline', fontFamily: 'system-ui, sans-serif', fontWeight: 800, letterSpacing: 0, lineHeight: 1.1, horizontalAlign: 'center', verticalAlign: 'middle', autoFit: true }), text: event.target.value.slice(0, 200) } } })} /></label>
                <label className="field"><span>글자 사용 방식</span><select value={project.shape.kind === 'text' ? project.shape.settings.mode : 'outline'} onChange={(event) => {
                  const mode = event.target.value as 'outline' | 'obstacle' | 'secret'
                  const settings = project.shape.kind === 'text' ? project.shape.settings : { text: '꿈', mode: 'outline' as const, fontFamily: 'system-ui, sans-serif', fontWeight: 800, letterSpacing: 0, lineHeight: 1.1, horizontalAlign: 'center' as const, verticalAlign: 'middle' as const, autoFit: true }
                  onChange({ ...project, shape: { kind: 'text', settings: { ...settings, mode } }, ...(mode === 'secret' ? { secretReveal: { ...project.secretReveal, content: { kind: 'message', message: settings.text } } } : {}) })
                }}><option value="outline">전체 윤곽</option><option value="obstacle">내부 장애물</option><option value="secret">시크릿 콘텐츠</option></select></label>
                <div className="settings-row">
                  <label className="field"><span>글꼴</span><select value={project.shape.kind === 'text' ? project.shape.settings.fontFamily : 'system-ui, sans-serif'} onChange={(event) => project.shape.kind === 'text' && onChange({ ...project, shape: { ...project.shape, settings: { ...project.shape.settings, fontFamily: event.target.value } } })}><option value="system-ui, sans-serif">고딕</option><option value="Georgia, serif">명조</option><option value="monospace">고정폭</option><option value="cursive">손글씨</option></select></label>
                  <label className="field"><span>굵기</span><select value={project.shape.kind === 'text' ? project.shape.settings.fontWeight : 800} onChange={(event) => project.shape.kind === 'text' && onChange({ ...project, shape: { ...project.shape, settings: { ...project.shape.settings, fontWeight: Number(event.target.value) } } })}><option value={400}>보통</option><option value={600}>굵게</option><option value={800}>매우 굵게</option></select></label>
                </div>
                <div className="settings-row">
                  <label className="field"><span>자간</span><input type="number" min="-4" max="20" value={project.shape.kind === 'text' ? project.shape.settings.letterSpacing : 0} onChange={(event) => project.shape.kind === 'text' && onChange({ ...project, shape: { ...project.shape, settings: { ...project.shape.settings, letterSpacing: Number(event.target.value) } } })} /></label>
                  <label className="field"><span>행간</span><input type="number" min="0.8" max="2" step="0.1" value={project.shape.kind === 'text' ? project.shape.settings.lineHeight : 1.1} onChange={(event) => project.shape.kind === 'text' && onChange({ ...project, shape: { ...project.shape, settings: { ...project.shape.settings, lineHeight: Number(event.target.value) } } })} /></label>
                </div>
                <div className="settings-row">
                  <label className="field"><span>가로 정렬</span><select value={project.shape.kind === 'text' ? project.shape.settings.horizontalAlign : 'center'} onChange={(event) => project.shape.kind === 'text' && onChange({ ...project, shape: { ...project.shape, settings: { ...project.shape.settings, horizontalAlign: event.target.value as 'left' | 'center' | 'right' } } })}><option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option></select></label>
                  <label className="field"><span>세로 정렬</span><select value={project.shape.kind === 'text' ? project.shape.settings.verticalAlign : 'middle'} onChange={(event) => project.shape.kind === 'text' && onChange({ ...project, shape: { ...project.shape, settings: { ...project.shape.settings, verticalAlign: event.target.value as 'top' | 'middle' | 'bottom' } } })}><option value="top">위</option><option value="middle">가운데</option><option value="bottom">아래</option></select></label>
                </div>
                <label className="toggle-row compact"><input type="checkbox" checked={project.shape.kind === 'text' ? project.shape.settings.autoFit : true} onChange={(event) => project.shape.kind === 'text' && onChange({ ...project, shape: { ...project.shape, settings: { ...project.shape.settings, autoFit: event.target.checked } } })} /><span>크기 자동 맞춤</span></label>
                <button className="button" onClick={() => void onGenerate(project)}><WandSparkles size={17} />텍스트 미로 적용</button>
              </>
            )}
            {source === 'image' && (
              <>
                <label
                  className="dropzone"
                  tabIndex={0}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    void handleImage(event.dataTransfer.files[0])
                  }}
                  onPaste={(event) => {
                    const file =
                      event.clipboardData.files[0] ??
                      [...event.clipboardData.items]
                        .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
                        ?.getAsFile()
                    if (file) {
                      event.preventDefault()
                      void handleImage(file)
                    }
                  }}
                >
                  <Upload size={24} />
                  <strong>이미지를 놓거나 선택하세요</strong>
                  <small>JPG · PNG · WEBP · SVG / 브라우저 안에서만 처리</small>
                  <input className="sr-only" type="file" accept=".jpg,.jpeg,.png,.webp,.svg,image/jpeg,image/png,image/webp,image/svg+xml" onChange={(event) => void handleImage(event.target.files?.[0])} />
                </label>
                {project.shape.kind === 'image' && (
                  <>
                    <div className="image-before-after"><img src={project.shape.settings.dataUrl} alt="업로드 이미지 미리보기" /><span>전처리 원본</span></div>
                    <label className="field"><span>확대·축소 {Math.round(project.shape.settings.scale * 100)}%</span><input type="range" min="0.35" max="2" step="0.05" value={project.shape.settings.scale} onChange={(event) => updateImageSettings({ scale: Number(event.target.value) })} /></label>
                    <div className="settings-row">
                      <label className="field"><span>가로 이동</span><input type="range" min="-0.75" max="0.75" step="0.01" value={project.shape.settings.crop.x} onChange={(event) => updateImageCrop({ x: Number(event.target.value) })} /></label>
                      <label className="field"><span>세로 이동</span><input type="range" min="-0.75" max="0.75" step="0.01" value={project.shape.settings.crop.y} onChange={(event) => updateImageCrop({ y: Number(event.target.value) })} /></label>
                    </div>
                    <div className="settings-row">
                      <label className="field"><span>자르기 너비</span><input type="range" min="0.25" max="1.5" step="0.05" value={project.shape.settings.crop.width} onChange={(event) => updateImageCrop({ width: Number(event.target.value) })} /></label>
                      <label className="field"><span>자르기 높이</span><input type="range" min="0.25" max="1.5" step="0.05" value={project.shape.settings.crop.height} onChange={(event) => updateImageCrop({ height: Number(event.target.value) })} /></label>
                    </div>
                    <label className="field"><span>회전 {project.shape.settings.rotation}°</span><input type="range" min="-180" max="180" step="1" value={project.shape.settings.rotation} onChange={(event) => updateImageSettings({ rotation: Number(event.target.value) })} /></label>
                    <label className="field"><span>임계값 {project.shape.settings.threshold}</span><input type="range" min="20" max="235" value={project.shape.settings.threshold} onChange={(event) => updateImageSettings({ threshold: Number(event.target.value) })} /></label>
                    <label className="field"><span>가장자리 부드럽게 {project.shape.settings.smoothing}</span><input type="range" min="0" max="3" step="1" value={project.shape.settings.smoothing} onChange={(event) => updateImageSettings({ smoothing: Number(event.target.value) })} /></label>
                    <label className="field"><span>작은 노이즈 제거 {project.shape.settings.noiseRemoval}</span><input type="range" min="1" max="20" step="1" value={project.shape.settings.noiseRemoval} onChange={(event) => updateImageSettings({ noiseRemoval: Number(event.target.value) })} /></label>
                    {([
                      ['grayscale', '흑백 변환'],
                      ['inverted', '반전'],
                      ['fillInterior', '형태 내부 채우기'],
                      ['largestComponentOnly', '가장 큰 연결 영역만'],
                    ] as const).map(([key, label]) => (
                      <label className="toggle-row compact" key={key}><input type="checkbox" checked={project.shape.kind === 'image' && project.shape.settings[key]} onChange={(event) => updateImageSettings({ [key]: event.target.checked })} /><span>{label}</span></label>
                    ))}
                    <button className="button" onClick={() => void onGenerate(project)}><WandSparkles size={17} />전처리 적용</button>
                  </>
                )}
              </>
            )}
            {source === 'drawing' && (
              <>
                <div className="notice">캔버스에서 한 손가락이나 포인터로 실루엣을 그리세요. 두 손가락은 확대·이동에 사용됩니다.</div>
                <label className="field"><span>브러시 크기</span><input type="range" min="0.015" max="0.12" step="0.005" value={project.shape.kind === 'drawing' ? project.shape.brushSize : 0.045} onChange={(event) => project.shape.kind === 'drawing' && onChange({ ...project, shape: { ...project.shape, brushSize: Number(event.target.value) } })} /></label>
                <button className="button secondary" onClick={() => {
                  const next = { ...project, shape: { kind: 'drawing' as const, paths: [], brushSize: project.shape.kind === 'drawing' ? project.shape.brushSize : 0.045 } }
                  onChange(next)
                  void onGenerate(next)
                }}>그림 지우기</button>
              </>
            )}
          </div>
        </>
      )
    }

    if (step === 2) {
      const draftCols = clampGridSize(gridDraft.cols, project.grid.cols)
      const draftRows = clampGridSize(gridDraft.rows, project.grid.rows)
      const sizePending =
        draftCols !== project.mazeGraph.cols || draftRows !== project.mazeGraph.rows
      return (
        <>
          <div className="inspector-section settings-stack">
            <div className="segmented maze-panel-tabs" aria-label="미로 설정 방식">
              <button aria-pressed={mazePanelMode === 'generate'} className={mazePanelMode === 'generate' ? 'active' : ''} onClick={() => setMazePanelMode('generate')}>크기·생성</button>
              <button aria-pressed={mazePanelMode === 'edit'} className={mazePanelMode === 'edit' ? 'active' : ''} onClick={() => setMazePanelMode('edit')}>직접 수정</button>
            </div>
          </div>
          {mazePanelMode === 'generate' ? (
            <>
              <div className="inspector-section settings-stack">
                <label className="field"><span>난이도</span><select aria-label="난이도" disabled={state === 'generating'} value={project.difficulty} onChange={(event) => update('difficulty', event.target.value as DifficultyLevel)}>{difficultyOptions.map((value) => <option key={value} value={value}>{difficultyLabel(value)}</option>)}</select></label>
                <div className="settings-row grid-size-fields">
                  <label className="field"><span>가로 셀</span><input type="number" inputMode="numeric" enterKeyHint="done" min="8" max="150" step="1" disabled={state === 'generating'} value={gridDraft.cols} onChange={(event) => setGridDraft((value) => ({ ...value, cols: event.target.value }))} onBlur={projectFromGridDraft} onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      setGridDraft((value) => ({ ...value, cols: String(project.grid.cols) }))
                    }
                  }} /></label>
                  <label className="field"><span>세로 셀</span><input type="number" inputMode="numeric" enterKeyHint="done" min="8" max="150" step="1" disabled={state === 'generating'} value={gridDraft.rows} onChange={(event) => setGridDraft((value) => ({ ...value, rows: event.target.value }))} onBlur={projectFromGridDraft} onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      setGridDraft((value) => ({ ...value, rows: String(project.grid.rows) }))
                    }
                  }} /></label>
                </div>
                <div className="grid-presets" aria-label="미로 크기 빠른 선택">
                  {([[16, 16], [24, 24], [32, 24], [48, 36]] as const).map(([cols, rows]) => (
                    <button key={`${cols}x${rows}`} disabled={state === 'generating'} aria-pressed={draftCols === cols && draftRows === rows} className={draftCols === cols && draftRows === rows ? 'active' : ''} onClick={() => setGridPreset(cols, rows)}>{cols}×{rows}</button>
                  ))}
                </div>
                {sizePending && <div className="notice pending-size-notice">현재 캔버스는 {project.mazeGraph.cols}×{project.mazeGraph.rows}입니다. 아래 버튼을 누르면 {draftCols}×{draftRows}로 다시 만듭니다.</div>}
                <label className="field seed-field">
                  <span>Seed (선택)</span>
                  <input
                    aria-label="Seed"
                    disabled={state === 'generating'}
                    value={seedDraft}
                    maxLength={120}
                    placeholder="비워두면 새 Seed 자동 생성"
                    onChange={(event) => setSeedDraft(event.target.value.replace(/[^\p{L}\p{N}_. -]/gu, ''))}
                  />
                  <small>비워두면 누를 때마다 새 미로 · 입력하면 같은 미로 재현</small>
                </label>
                <div className="current-seed" aria-label="현재 미로 Seed">
                  <span>현재 Seed</span>
                  <code title={project.seed}>{project.seed}</code>
                  <button
                    type="button"
                    disabled={state === 'generating'}
                    onClick={() => setSeedDraft(project.seed)}
                  >
                    현재 Seed 사용
                  </button>
                </div>
                <button className="button" disabled={state === 'generating'} onClick={() => void generateMazeFromDraft()}><WandSparkles size={17} />{seedDraft.trim() ? '입력한 Seed로 미로 재현' : '새 Seed로 미로 다시 생성'}</button>
                <button className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}><Settings2 size={16} />고급 설정<ChevronRight className={advanced ? 'rotated' : ''} size={16} /></button>
                {advanced && (
                  <>
                    <label className="field"><span>생성 알고리즘</span><select disabled={state === 'generating'} value={project.mazeGraph.algorithm} onChange={(event) => {
                      const algorithm = event.target.value as MazeAlgorithm
                      onChange({ ...project, mazeGraph: { ...project.mazeGraph, algorithm } })
                      if (generationAnimation !== 'none') setGenerationAnimation(algorithm)
                    }}><option value="dfs">DFS 탐색</option><option value="kruskal">Kruskal 벽 제거</option><option value="prim">Prim 영역 확장</option></select></label>
                    <label className="field"><span>생성 애니메이션</span><select disabled={state === 'generating'} value={generationAnimation} onChange={(event) => {
                      const mode = event.target.value as 'none' | MazeAlgorithm
                      setGenerationAnimation(mode)
                      if (mode !== 'none') onChange({ ...project, mazeGraph: { ...project.mazeGraph, algorithm: mode } })
                    }}><option value="none">없음</option><option value="dfs">DFS 탐색</option><option value="kruskal">Kruskal 벽 제거</option><option value="prim">Prim 영역 확장</option></select></label>
                  </>
                )}
              </div>
              <QualityCard project={project} validation={validation} onRepair={autoRepair} />
            </>
          ) : (
            <div className="inspector-section settings-stack edit-tools-section">
              <div className="notice editor-help">도구를 고르면 설정창이 닫힙니다. 벽 가까이를 누르거나 쓸어 편집하고, 두 손가락으로 확대·이동하세요.</div>
              <div className="editor-tool-grid">
                {toolOptions.map(({ id, label, icon: Icon }) => (
                  <button key={id} className={tool === id && editorEnabled ? 'active' : ''} onClick={() => chooseEditorTool(id)}><Icon size={17} />{label}</button>
                ))}
              </div>
              <div className="settings-row">
                <button className="button secondary small" disabled={!history.canUndo} onClick={() => restoreEditorHistory('undo')}><Undo2 size={15} />실행 취소</button>
                <button className="button secondary small" disabled={!history.canRedo} onClick={() => restoreEditorHistory('redo')}><Redo2 size={15} />다시 실행</button>
              </div>
              <button className="button ghost small" onClick={() => {
                finishWallEdit(false)
                const next = projectFromEditorSnapshot(project, editBaselineRef.current)
                historyRef.current.reset(editorSnapshotFromProject(next))
                acknowledgedEditorGraphRef.current = next.mazeGraph
                onChange(next)
              }}>편집 전 상태로</button>
              <div className="transform-grid">
                <button onClick={() => {
                  const swapped = swapEndpoints(project.startCell, project.endCell)
                  commit({ ...project, startCell: swapped.start, endCell: swapped.end })
                }}><ArrowLeftRight size={16} />시작·종료 교환</button>
                <button onClick={() => applyTransform('flip-horizontal')}>↔ 좌우 반전</button>
                <button onClick={() => applyTransform('flip-vertical')}>↕ 상하 반전</button>
                <button onClick={() => applyTransform('rotate-clockwise')}><RotateCw size={16} />90° 회전</button>
              </div>
              {editorEnabled && <button className="button secondary" onClick={() => {
                finishWallEdit(true)
                setEditorEnabled(false)
                setSheetOpen(false)
              }}><CheckCircle2 size={17} />편집 완료</button>}
            </div>
          )}
        </>
      )
    }

    if (step === 3) {
      const secret = project.secretReveal.content
      return (
        <>
          <div className="inspector-section settings-stack">
            <label className="field"><span>게임 모드</span><select value={project.gameRules.mode} onChange={(event) => update('gameRules', { ...project.gameRules, mode: event.target.value as 'classic' | 'time-attack' | 'checkpoint' })}><option value="classic">클래식</option><option value="time-attack">타임어택</option><option value="checkpoint">체크포인트</option></select></label>
            <div className="settings-row">
              <label className="field"><span>제한 시간(초)</span><input type="number" min="10" max="3600" disabled={project.gameRules.mode !== 'time-attack'} value={project.gameRules.timeLimitSeconds ?? 120} onChange={(event) => update('gameRules', { ...project.gameRules, timeLimitSeconds: Number(event.target.value) })} /></label>
              <label className="field"><span>힌트 횟수</span><input type="number" min="0" max="20" value={project.gameRules.allowedHints} onChange={(event) => update('gameRules', { ...project.gameRules, allowedHints: Number(event.target.value) })} /></label>
            </div>
            <label className="toggle-row compact"><input type="checkbox" checked={project.gameRules.showDpad} onChange={(event) => update('gameRules', { ...project.gameRules, showDpad: event.target.checked })} /><span>화면 방향 패드</span></label>
            <label className="toggle-row compact"><input type="checkbox" checked={project.gameRules.ghostAllowed} onChange={(event) => update('gameRules', { ...project.gameRules, ghostAllowed: event.target.checked })} /><span>제작자 고스트 대결</span></label>
          </div>
          <div className="inspector-section settings-stack">
            <p className="panel-label">시크릿 리빌</p>
            <label className="field"><span>콘텐츠</span><select value={secret.kind} onChange={(event) => {
              const kind = event.target.value
              const content =
                kind === 'message' ? { kind: 'message' as const, message: '' }
                  : kind === 'image' ? { kind: 'image' as const, imageDataUrl: '', alt: '' }
                    : kind === 'image-message' ? { kind: 'image-message' as const, imageDataUrl: '', alt: '', message: '' }
                      : kind === 'link' ? { kind: 'link' as const, label: '링크 열기', url: 'https://' }
                        : kind === 'coupon' ? { kind: 'coupon' as const, code: '', message: '' }
                          : kind === 'hint' ? { kind: 'hint' as const, message: '', nextLocation: '' }
                            : { kind: 'none' as const }
              update('secretReveal', { ...project.secretReveal, content })
            }}><option value="none">사용 안 함</option><option value="message">메시지·편지</option><option value="image">이미지</option><option value="image-message">이미지와 메시지</option><option value="link">링크 버튼</option><option value="coupon">쿠폰 코드</option><option value="hint">다음 장소 힌트</option></select></label>
            {(secret.kind === 'message' || secret.kind === 'image-message' || secret.kind === 'coupon' || secret.kind === 'hint') && (
              <label className="field"><span>메시지</span><textarea value={secret.message} maxLength={20000} onChange={(event) => update('secretReveal', { ...project.secretReveal, content: { ...secret, message: event.target.value } })} /></label>
            )}
            {(secret.kind === 'image' || secret.kind === 'image-message') && (
              <label className="dropzone"><FileImage size={22} /><strong>숨길 이미지 선택</strong><small>공유 크기에 맞게 복사본을 축소합니다</small><input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                try {
                  const imageDataUrl = await resizeImage(file)
                  update('secretReveal', { ...project.secretReveal, content: { ...secret, imageDataUrl, alt: file.name.slice(0, 200) } })
                } catch (error) {
                  onToast(error instanceof Error ? error.message : '이미지를 처리할 수 없습니다.', true)
                }
              }} /></label>
            )}
            {secret.kind === 'link' && (
              <><label className="field"><span>버튼 문구</span><input value={secret.label} onChange={(event) => update('secretReveal', { ...project.secretReveal, content: { ...secret, label: event.target.value } })} /></label><label className="field"><span>링크</span><input type="url" value={secret.url} onChange={(event) => update('secretReveal', { ...project.secretReveal, content: { ...secret, url: event.target.value } })} /></label></>
            )}
            {secret.kind === 'coupon' && <label className="field"><span>쿠폰 코드</span><input value={secret.code} onChange={(event) => update('secretReveal', { ...project.secretReveal, content: { ...secret, code: event.target.value } })} /></label>}
            {secret.kind === 'hint' && <label className="field"><span>다음 장소</span><input value={secret.nextLocation} onChange={(event) => update('secretReveal', { ...project.secretReveal, content: { ...secret, nextLocation: event.target.value } })} /></label>}
            <label className="field"><span>공개 방식</span><select value={project.secretReveal.mode} onChange={(event) => update('secretReveal', { ...project.secretReveal, mode: event.target.value as MazeProject['secretReveal']['mode'] })}><option value="visited-cells">이동한 칸 공개</option><option value="solution-path">정답 경로 공개</option><option value="checkpoints">체크포인트 공개</option><option value="on-complete">완주 후 전체 공개</option></select></label>
            <label className="field"><span>공개 애니메이션</span><select value={project.secretReveal.animation} onChange={(event) => update('secretReveal', { ...project.secretReveal, animation: event.target.value as MazeProject['secretReveal']['animation'] })}><option value="fade">페이드</option><option value="puzzle">조각 맞추기</option><option value="unmask">마스크 걷히기</option><option value="zoom">확대되며 공개</option><option value="none">끄기</option></select></label>
          </div>
          <div className="inspector-section settings-stack">
            <button className="button" onClick={() => onPlay(false)}><Play size={17} />플레이 테스트</button>
            <button className="button secondary" onClick={() => onPlay(true)}><FlagIcon size={17} />고스트 기록 저장</button>
          </div>
        </>
      )
    }

    if (step === 4) {
      return (
        <>
          <div className="inspector-section settings-stack">
            <p className="panel-label">미로 색상</p>
            <div className="settings-row">
              <label className="field"><span>벽</span><input type="color" value={project.visualTheme.wallColor} onChange={(event) => update('visualTheme', { ...project.visualTheme, wallColor: event.target.value })} /></label>
              <label className="field"><span>통로</span><input type="color" value={project.visualTheme.pathColor} onChange={(event) => update('visualTheme', { ...project.visualTheme, pathColor: event.target.value })} /></label>
              <label className="field"><span>시작점</span><input type="color" value={project.visualTheme.startColor} onChange={(event) => update('visualTheme', { ...project.visualTheme, startColor: event.target.value })} /></label>
              <label className="field"><span>종료점</span><input type="color" value={project.visualTheme.endColor} onChange={(event) => update('visualTheme', { ...project.visualTheme, endColor: event.target.value })} /></label>
            </div>
            <label className="field"><span>벽 두께 {project.visualTheme.wallWidth.toFixed(1)}</span><input type="range" min="0.5" max="6" step="0.5" value={project.visualTheme.wallWidth} onChange={(event) => update('visualTheme', { ...project.visualTheme, wallWidth: Number(event.target.value) })} /></label>
          </div>
          <div className="inspector-section settings-stack">
            <p className="panel-label">배경</p>
            <label className="field"><span>배경 종류</span><select value={project.background.kind} onChange={(event) => {
              const kind = event.target.value
              update('background', kind === 'grid' ? { kind: 'grid', color: '#fafaf7', lineColor: '#e1e3db', spacing: 16 } : kind === 'paper' ? { kind: 'paper', color: '#fbf8ee', grain: 0.08 } : { kind: 'solid', color: '#ffffff' })
            }}><option value="solid">단색</option><option value="grid">그리드</option><option value="paper">종이</option></select></label>
            {'color' in project.background && <label className="field"><span>배경색</span><input type="color" value={project.background.color} onChange={(event) => {
              if ('color' in project.background) update('background', { ...project.background, color: event.target.value })
            }} /></label>}
          </div>
        </>
      )
    }

    if (step === 5) {
      return (
        <>
          <QualityCard project={project} validation={validation} onRepair={autoRepair} />
          <div className="inspector-section settings-stack">
            <p className="panel-label">풀이 애니메이션</p>
            <label className="field"><span>표현 방식</span><select value={animationMode} onChange={(event) => setAnimationMode(event.target.value as typeof animationMode)}><option value="path">정답 경로 표시</option><option value="water">2D 물 채우기</option><option value="particle">파티클 채우기</option></select></label>
            <label className="field"><span>효과 품질</span><select value={effectQuality} onChange={(event) => setEffectQuality(event.target.value as typeof effectQuality)}><option value="auto">기기 성능에 맞춤</option><option value="low">낮음</option><option value="high">높음</option></select></label>
            {animationMode === 'particle' && <label className="field"><span>파티클 밀도 {particleDensity}</span><input type="range" min="1" max="10" value={particleDensity} onChange={(event) => setParticleDensity(Number(event.target.value))} /></label>}
            <button className="button" onClick={openWaterSimulation} disabled={!validation.valid}><Droplets size={17} />3D 물 시뮬레이션</button>
            <button className="button secondary" onClick={() => void playSolveAnimation()}><Lightbulb size={17} />풀이 애니메이션</button>
            <button className="button" onClick={() => onPlay(false)}><Play size={17} />직접 플레이 테스트</button>
            <button className="button secondary" onClick={() => onPlay(true)}><FlagIcon size={17} />제작자 고스트 기록</button>
          </div>
        </>
      )
    }

    return (
      <>
        <div className="inspector-section settings-stack">
          <label className="field"><span>제작자 표시명</span><input value={project.creatorDisplayName} maxLength={120} placeholder="선택 입력" onChange={(event) => update('creatorDisplayName', event.target.value)} /></label>
          <label className="toggle-row"><input type="checkbox" checked={project.remixAllowed} onChange={(event) => update('remixAllowed', event.target.checked)} /><span><strong>리믹스 허용</strong><small>받은 사람이 원본을 보존한 복제본을 만들 수 있습니다.</small></span></label>
        </div>
        <div className="inspector-section settings-stack">
          <button className="button" onClick={onShare}><Share2 size={17} />공유 링크와 QR</button>
          <button className="button secondary" onClick={onExport}><Download size={17} />파일로 내보내기</button>
          <div className="notice">링크가 너무 길면 .mazecraft 프로젝트 또는 독립 실행 HTML을 사용하세요.</div>
        </div>
      </>
    )
  })()

  const defaultMobileEditTools: EditorTool[] = ['open-wall', 'close-wall', 'pan']
  const mobileEditTools: EditorTool[] = defaultMobileEditTools.includes(tool)
    ? defaultMobileEditTools
    : [tool, 'open-wall', 'pan']
  const drawingMode = editorEnabled && step === 1 && source === 'drawing'
  const activeToolLabel = drawingMode
    ? '실루엣 그리기'
    : toolOptions.find((item) => item.id === tool)?.label ?? '편집'

  return (
    <>
    <main
      className="studio-root"
      data-inspector-collapsed={inspectorCollapsed}
      data-focus-mode={focusMode}
      data-sheet-open={sheetOpen}
      data-editor-enabled={editorEnabled}
      data-step={step}
    >
      <header className="studio-header no-print" inert={compactLayout && sheetOpen ? '' : undefined} aria-hidden={compactLayout && sheetOpen ? true : undefined}>
        <button className="brand" onClick={onHome} aria-label="홈으로">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span><strong>MazeCraft</strong><small>제작실</small></span>
        </button>
        <div className="studio-project-title">
          <small>현재 프로젝트</small>
          <input aria-label="프로젝트 제목" value={project.title} maxLength={200} onChange={(event) => update('title', event.target.value)} />
          <span className={`save-state ${saveStatus.state === 'error' ? 'error' : ''}`} aria-live="polite">
            {saveStatus.state === 'saving' ? '저장 중…' : saveStatus.state === 'error' ? '저장 실패' : saveStatus.state === 'saved' ? <><CheckCircle2 size={13} />저장됨</> : ''}
          </span>
        </div>
        <div className="studio-header-actions">
          <button
            className={`icon-button focus-button ${focusMode ? 'active' : ''}`}
            aria-label={focusMode ? '집중 모드 종료' : '캔버스 집중 모드'}
            aria-pressed={focusMode}
            onClick={toggleFocusMode}
            title={focusMode ? '패널 다시 열기' : '캔버스만 크게 보기'}
          >
            {focusMode ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button className="icon-button" aria-label={dark ? '라이트 모드' : '다크 모드'} onClick={onThemeToggle}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
          <button className="button secondary desktop-only" aria-label="테스트" onClick={() => onPlay(false)}><Play size={16} /><span>테스트</span></button>
          <button className="button" aria-label="공유" onClick={onShare}><Share2 size={16} /><span>공유</span></button>
        </div>
      </header>

      <div className="studio-layout">
        <nav className="studio-stage-rail no-print" aria-label="제작 단계">
          <div className="stage-rail-heading"><span>BUILD</span><small>01—06</small></div>
          {steps.map(({ id, title, icon: Icon }) => (
            <button
              key={id}
              className={step === id ? 'active' : ''}
              aria-current={step === id ? 'step' : undefined}
              aria-label={`${id}단계 ${title}`}
              data-ready={id < step || (id >= 5 && validation.valid)}
              data-step-number={String(id).padStart(2, '0')}
              onClick={() => selectStep(id)}
            >
              <span><Icon size={17} /></span>
              <strong>{title}</strong>
            </button>
          ))}
        </nav>
        <section className="canvas-workspace" inert={compactLayout && sheetOpen ? '' : undefined} aria-hidden={compactLayout && sheetOpen ? true : undefined}>
          <div className="canvas-toolbar no-print">
            <div className="toolbar-group editing-controls">
              <button className="step-context" onClick={(event) => selectStep(step, true, event.currentTarget)} title="현재 단계 설정 열기">
                <span>{String(step).padStart(2, '0')}</span>
                <strong>{steps.find((item) => item.id === step)?.title}</strong>
              </button>
              <button
                className={`toolbar-button edit-tool ${editorEnabled ? 'active' : ''}`}
                aria-label={editorEnabled ? '미로 편집 완료' : '미로 편집 시작'}
                aria-pressed={editorEnabled}
                onClick={toggleEditor}
              >
                {editorEnabled ? <CheckCircle2 size={17} /> : <PencilLine size={17} />}<span>{editorEnabled ? '편집 완료' : '미로 편집'}</span>
              </button>
              <span className="toolbar-separator history-tool" />
              <button className="toolbar-button history-tool" disabled={!history.canUndo} aria-label="실행 취소" onClick={() => restoreEditorHistory('undo')}><Undo2 size={17} /></button>
              <button className="toolbar-button history-tool" disabled={!history.canRedo} aria-label="다시 실행" onClick={() => restoreEditorHistory('redo')}><Redo2 size={17} /></button>
            </div>
            <div className="toolbar-group view-controls">
              <button
                className="toolbar-button water-tool"
                aria-label="3D 물 시뮬레이션 열기"
                disabled={!validation.valid}
                onClick={openWaterSimulation}
              >
                <Droplets size={17} /><span>3D 물</span>
              </button>
              <span className="toolbar-separator zoom-step-tool" />
              <button className="toolbar-button zoom-step-tool" aria-label="축소" onClick={() => canvasRef.current?.zoomOut()}><Minus size={17} /></button>
              <button className="toolbar-button" aria-label="화면 맞춤" onClick={() => canvasRef.current?.fit()}><Scan size={17} /><span>맞춤</span></button>
              <button className="toolbar-button zoom-step-tool" aria-label="확대" onClick={() => canvasRef.current?.zoomIn()}><Plus size={17} /></button>
              <span className="toolbar-separator" />
              <button
                className={`toolbar-button solution-tool ${showSolution ? 'active' : ''}`}
                aria-label={showSolution ? '정답 경로 숨기기' : '정답 경로 그리기'}
                aria-pressed={showSolution}
                disabled={solution.length === 0}
                onClick={toggleSolutionPath}
              >
                <Lightbulb size={17} /><span>정답 경로</span>
              </button>
              <button className="toolbar-button validation-tool" aria-label="검증" onClick={(event) => selectStep(5, true, event.currentTarget)}><ShieldCheck size={17} /><span>검증</span></button>
              <span className="toolbar-separator" />
              <button
                className={`toolbar-button panel-trigger ${inspectorPanelOpen ? 'active' : ''}`}
                aria-label={inspectorPanelOpen ? '설정 패널 접기' : '설정 패널 펼치기'}
                aria-expanded={inspectorPanelOpen}
                aria-controls="maze-settings-panel"
                onClick={(event) => toggleInspectorPanel(event.currentTarget)}
                title={inspectorPanelOpen ? '설정 패널 접기' : '설정 패널 펼치기'}
              >
                {inspectorPanelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
                <span>설정</span>
              </button>
            </div>
          </div>
          <div className="canvas-viewport">
            <MazeCanvas
              ref={canvasRef}
              className="maze-canvas-shell"
              model={canvasModel}
              mode={editorEnabled ? 'edit' : 'view'}
              singlePointerAction={
                editorEnabled
                  ? tool === 'pan'
                    ? 'pan'
                    : tool === 'zoom'
                      ? 'zoom'
                      : 'edit'
                  : 'auto'
              }
              preferWallHit={editorEnabled && step === 2 && (tool === 'open-wall' || tool === 'close-wall')}
              commitEditOnPinch={editorEnabled && step === 2 && (tool === 'open-wall' || tool === 'close-wall')}
              onEditGesture={handleEditGesture}
              frame={rendererFrame}
              theme={{
                canvas: project.background.kind === 'solid' || project.background.kind === 'paper' || project.background.kind === 'grid' ? project.background.color : '#f4f4ee',
                mazeFill: project.visualTheme.pathColor,
                wall: project.visualTheme.wallColor,
                start: project.visualTheme.startColor,
                end: project.visualTheme.endColor,
                solution: project.visualTheme.accentColor,
              }}
              ariaLabel={`${project.title} 제작 캔버스. 두 손가락으로 확대하고 이동할 수 있습니다.`}
            />
            {editorEnabled && (
              <div className="canvas-edit-hint" role="status">
                <PencilLine size={15} />
                <span><strong>{activeToolLabel}</strong>{drawingMode ? ' · 한 손가락으로 윤곽 그리기, 두 손가락 확대·이동' : tool === 'pan' ? ' · 한 손가락 이동, 두 손가락 확대' : ' · 누르거나 쓸어 편집, 두 손가락 확대·이동'}</span>
              </div>
            )}
          </div>
          <div className="canvas-statusbar no-print">
            <span>{project.mazeGraph.cols}×{project.mazeGraph.rows} · {difficultyLabel(project.difficulty)} · 최단 {project.mazeMetrics.pathLength.toLocaleString()}칸</span>
            <span>{editorEnabled ? `${toolOptions.find((item) => item.id === tool)?.label} 도구` : `${project.mazeMetrics.activeCells.toLocaleString()}개 유효 셀`} · {validation.valid ? '공유 준비 완료' : `수정할 문제 ${validation.issues.length}건`}</span>
          </div>
          {(state === 'generating' || generationProgress) && (
            <div className="busy-overlay" aria-live="polite">
              <div className="progress-card">
                <strong>난이도에 맞는 후보를 비교하고 있습니다</strong>
                <span>{generationProgress?.completed ?? 0} / {generationProgress?.total ?? 1} 후보</span>
                <div className="progress-track"><span style={{ width: `${((generationProgress?.completed ?? 0) / Math.max(1, generationProgress?.total ?? 1)) * 100}%` }} /></div>
                <button className="button secondary" onClick={onCancelGeneration}>취소</button>
              </div>
            </div>
          )}
        </section>

        {sheetOpen && <div className="mobile-sheet-scrim" onPointerDown={() => setSheetOpen(false)} />}
        <aside
          id="maze-settings-panel"
          className={`inspector no-print ${sheetOpen ? 'open' : ''}`}
          inert={compactLayout && !sheetOpen ? '' : undefined}
          aria-hidden={compactLayout && !sheetOpen ? true : undefined}
          role={compactLayout ? 'dialog' : undefined}
          aria-modal={compactLayout && sheetOpen ? true : undefined}
          aria-labelledby="maze-settings-title"
        >
          <button
            className="sheet-grabber"
            aria-label="설정 패널 닫기"
            onClick={() => setSheetOpen(false)}
            onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
              if (event.pointerType === 'touch') sheetStartRef.current = event.clientY
            }}
            onPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
              if (sheetStartRef.current !== null && event.clientY - sheetStartRef.current > 70) setSheetOpen(false)
              sheetStartRef.current = null
            }}
          ><span /></button>
          <header className="inspector-heading">
            <div><strong id="maze-settings-title">{steps.find((item) => item.id === step)?.title}</strong><small>{steps.find((item) => item.id === step)?.hint}</small></div>
            <div className="inspector-heading-actions">
              <button className="icon-button inspector-collapse" aria-label="설정 패널 접기" onClick={() => setInspectorCollapsed(true)}><PanelRightClose size={18} /></button>
              <button ref={sheetCloseRef} className="icon-button sheet-close" aria-label="설정 닫기" onClick={() => setSheetOpen(false)}><X size={18} /></button>
            </div>
          </header>
          {inspectorContent}
          {project.attribution && (
            <div className="inspector-attribution">
              <span>리믹스 출처</span>
              <strong>{project.attribution.sourceTitle}</strong>
              {project.attribution.creatorDisplayName && <small>{project.attribution.creatorDisplayName}</small>}
            </div>
          )}
          <footer className="inspector-footer">
            <button
              className="button secondary"
              disabled={step === 1}
              onClick={() => selectStep(Math.max(1, step - 1) as StudioStep, compactLayout)}
            >
              이전
            </button>
            <span><strong>{step}</strong> / {steps.length}</span>
            <button
              className="button"
              onClick={() => {
                if (step === 6) {
                  setSheetOpen(false)
                  onShare()
                  return
                }
                selectStep(Math.min(6, step + 1) as StudioStep, compactLayout)
              }}
            >
              {step === 6 ? '공유하기' : `다음 · ${steps.find((item) => item.id === step + 1)?.title}`}
            </button>
          </footer>
        </aside>

        {editorEnabled && step === 2 && (
          <nav className="mobile-edit-dock no-print" aria-label="모바일 미로 편집 도구" inert={compactLayout && sheetOpen ? '' : undefined} aria-hidden={compactLayout && sheetOpen ? true : undefined}>
            {mobileEditTools.map((id) => {
              const item = toolOptions.find((candidate) => candidate.id === id)
              if (!item) return null
              const Icon = item.icon
              return <button key={id} className={tool === id ? 'active' : ''} aria-label={`${item.label} 도구`} aria-pressed={tool === id} onClick={() => chooseEditorTool(id)}><Icon size={18} /><span>{item.label}</span></button>
            })}
            <button disabled={!history.canUndo} aria-label="실행 취소" onClick={() => restoreEditorHistory('undo')}><Undo2 size={18} /><span>취소</span></button>
            <button disabled={!history.canRedo} aria-label="다시 실행" onClick={() => restoreEditorHistory('redo')}><Redo2 size={18} /><span>다시</span></button>
            <button className="done" aria-label="미로 편집 완료" onClick={() => {
              finishWallEdit(true)
              setEditorEnabled(false)
            }}><CheckCircle2 size={18} /><span>완료</span></button>
          </nav>
        )}
        <nav className="mobile-tabs no-print" aria-label="모바일 제작 탭" inert={compactLayout && sheetOpen ? '' : undefined} aria-hidden={compactLayout && sheetOpen ? true : undefined}>
          {mobileSteps.map((id) => {
            const item = steps.find((candidate) => candidate.id === id)!
            const Icon = item.icon
            return <button key={id} className={step === id ? 'active' : ''} aria-current={step === id ? 'step' : undefined} aria-label={item.title} data-step-number={String(id).padStart(2, '0')} onClick={(event) => selectStep(id, true, event.currentTarget)}><Icon size={19} />{item.title}</button>
          })}
        </nav>
      </div>
    </main>
    {waterSimulationOpen && waterSimulationProject && (
      <Suspense
        fallback={
          <div className="water-loading-overlay" role="status" aria-live="polite">
            <Droplets size={28} />
            <strong>3D 물 시뮬레이션을 준비하는 중…</strong>
          </div>
        }
      >
        <WaterSimulationDialog
          open
          project={waterSimulationProject}
          quality={effectQuality}
          onClose={() => {
            setWaterSimulationOpen(false)
            setWaterSimulationProject(null)
          }}
        />
      </Suspense>
    )}
    </>
  )
}

function QualityCard({
  project,
  validation,
  onRepair,
}: {
  project: MazeProject
  validation: MazeValidationResult
  onRepair: () => void
}) {
  const metrics = project.mazeMetrics
  return (
    <div className="inspector-section settings-stack">
      <p className="panel-label">MAZE IQ · 품질 분석</p>
      <div className="quality-card">
        <div className="quality-score"><strong>{metrics.difficultyScore}</strong><span>{scoreLabel(metrics.difficultyScore)}</span></div>
        <div className="quality-meter"><span style={{ width: `${metrics.difficultyScore}%` }} /></div>
        <div className="metric-grid">
          <div className="metric"><span>예상 완주</span><strong>약 {metrics.estimatedSeconds}초</strong></div>
          <div className="metric"><span>최단 경로</span><strong>{metrics.pathLength}칸</strong></div>
          <div className="metric"><span>갈림길</span><strong>{metrics.branches}개</strong></div>
          <div className="metric"><span>막다른 길</span><strong>{metrics.deadEnds}개</strong></div>
          <div className="metric"><span>방향 전환</span><strong>{metrics.turns}회</strong></div>
          <div className="metric"><span>유효 셀</span><strong>{metrics.activeCells.toLocaleString()}</strong></div>
          <div className="metric"><span>연결 상태</span><strong>{metrics.componentCount === 1 ? '연결됨' : `${metrics.componentCount}영역`}</strong></div>
          <div className="metric"><span>해답</span><strong>{metrics.solvable ? (metrics.hasLoops ? `루프 ${metrics.loopCount}` : '검증 완료') : '해결 불가'}</strong></div>
        </div>
      </div>
      <div className="validation-list">
        {validation.issues.length ? validation.issues.slice(0, 6).map((issue, index) => <div key={`${issue.code}-${index}`} className={`validation-item ${issue.severity}`}><ShieldCheck size={15} />{issue.message}</div>) : <div className="validation-item"><CheckCircle2 size={15} />공유 가능한 상태입니다.</div>}
      </div>
      {validation.issues.some((issue) => issue.autoFixable) && <button className="button secondary" onClick={onRepair}><WandSparkles size={16} />자동 복구 후 다시 검증</button>}
    </div>
  )
}
