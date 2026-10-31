import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type {
  CellPosition,
  CreatorReplay,
  MazeCandidate,
  MazeGenerationTraceStep,
  MazeProject,
  MazeWorkerResponse,
} from '../core/maze'
import {
  generateBestMazeCandidate,
  migrateProject,
  validateMaze,
} from '../core/maze'
import { createId } from '../core/id'
import { HomeScreen, type ProjectTemplate } from '../features/home/HomeScreen'
import { BrandMark } from '../components/BrandMark'
import { ProjectService } from '../features/projects/projectService'
// Direct imports keep the share dialog in its own lazily loaded file.
import { readShareHash, readShareRoute } from '../features/share/codec'
import { createRemixProject } from '../features/share/remix'
import { looksLikeBackup, MAX_BACKUP_FILE_SIZE } from '../features/backup/backupFormat'
import type { InfoTab } from '../features/info/InfoDialog'
import { resolveStudioQuality } from '../features/waterSimulation/graphics'
import { summarizeCampaign } from '../features/craft/campaignIndex'
import { createDailyMaze, dailyInfo, dailyKey, dailyStreak, readDailyRecord, recordDailyFinish } from '../features/daily/dailyMaze'
import {
  createAutosave,
  describeStorageError,
  localProjectRepository,
  readSettings,
  updateSettings,
  type AutosaveStatus,
  type ColorTheme,
  type EffectQuality,
} from '../storage'
import {
  applyMazeCandidate,
  createProjectFromTemplate,
  createProjectMask,
  prepareImageMaskProject,
} from './projectFactory'
import {
  initialMachineSnapshot,
  transitionAppState,
  type AppEvent,
  type MachineSnapshot,
} from './stateMachine'
import { isChunkLoadError, lazyScreen } from './chunkRecovery'
import { ErrorBoundary } from './ErrorBoundary'
import { hashFor, parseLocation, type AppLocation, type CraftMode, type Screen } from './routes'

type Route = 'loading' | Screen

const WaterStudio = lazyScreen(() => import('../features/waterStudio/WaterStudio'))
const CraftStudio = lazyScreen(() => import('../features/craft/CraftStudio'))
const InfoDialog = lazyScreen(() => import('../features/info/InfoDialog'))

const StudioScreen = lazyScreen(() =>
  import('../features/creator/StudioScreen').then((module) => ({
    default: module.StudioScreen,
  })),
)
const PlayerScreen = lazyScreen(() =>
  import('../features/player/PlayerScreen').then((module) => ({
    default: module.PlayerScreen,
  })),
)
const ShareDialog = lazyScreen(() =>
  import('../features/share/ShareDialog').then((module) => ({
    default: module.ShareDialog,
  })),
)
const ExportDialog = lazyScreen(() =>
  import('../features/export/ExportDialog').then((module) => ({
    default: module.ExportDialog,
  })),
)

interface Toast {
  id: number
  message: string
  error: boolean
}

/** Entries this app pushed, with the address they were pushed from. */
interface HistoryEntryState {
  mazecraft: 1
  fromHash: string
  /** The page load that pushed it: after a reload, Back would load a new document. */
  document: string
}

const service = new ProjectService(localProjectRepository)
const LAST_WATER_PROJECT_KEY = 'mazecraft.last-water-project-id'
const SAVE_ERROR_TOAST_INTERVAL_MS = 30_000

const DOCUMENT_ID = createId('page')

const baseUrl = () => location.pathname + location.search

function readHistoryState(): HistoryEntryState | null {
  const state = history.state as Partial<HistoryEntryState> | null
  return state?.mazecraft === 1 && typeof state.fromHash === 'string' ? (state as HistoryEntryState) : null
}

function rememberWaterSelection(id: string): void {
  try { localStorage.setItem(LAST_WATER_PROJECT_KEY, id) } catch { /* Optional navigation preference. */ }
}

function isLastWaterSelection(id: string): boolean {
  try { return localStorage.getItem(LAST_WATER_PROJECT_KEY) === id } catch { return false }
}

async function readFileHead(file: Blob, bytes: number): Promise<string> {
  const head = file.slice(0, bytes)
  if (typeof head.text === 'function') return head.text()
  return new Response(head).text()
}

function RouteFallback({ label }: { label: string }) {
  return (
    <main className="route-loading" aria-live="polite">
      <BrandMark size={40} />
      <strong>{label}</strong>
      <span className="route-loading-bar" aria-hidden="true"><i /></span>
    </main>
  )
}

function prefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

const candidateWithWorker = (
  project: MazeProject,
  mask: MazeProject['mask'],
  onProgress: (completed: number, total: number) => void,
  registerCancel: (cancel: () => void) => void,
): Promise<MazeCandidate> => {
  const payload = {
    rows: project.grid.rows,
    cols: project.grid.cols,
    seed: project.seed,
    difficulty: project.difficulty,
    algorithm: project.mazeGraph.algorithm,
    mask,
    minimumPassageWidth: project.grid.minimumCellPixels,
  } as const

  if (typeof Worker === 'undefined') {
    return new Promise((resolve, reject) => {
      let cancelled = false
      registerCancel(() => {
        cancelled = true
        reject(new DOMException('생성이 취소되었습니다.', 'AbortError'))
      })
      window.setTimeout(() => {
        if (cancelled) return
        try {
          resolve(
            generateBestMazeCandidate(payload, {
              onProgress: (progress) => onProgress(progress.completed, progress.total),
              isCancelled: () => cancelled,
            }),
          )
        } catch (error) {
          reject(error)
        }
      }, 0)
    })
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/maze.worker.ts', import.meta.url), { type: 'module' })
    const requestId = createId('maze-request')
    let settled = false
    const finish = () => {
      if (!settled) {
        settled = true
        worker.terminate()
      }
    }
    registerCancel(() => {
      worker.postMessage({ type: 'cancel', requestId })
      finish()
      reject(new DOMException('생성이 취소되었습니다.', 'AbortError'))
    })
    worker.addEventListener('message', (event: MessageEvent<MazeWorkerResponse>) => {
      const message = event.data
      if (message.requestId !== requestId || settled) return
      if (message.type === 'progress') {
        onProgress(message.progress.completed, message.progress.total)
      } else if (message.type === 'complete') {
        finish()
        resolve(message.result)
      } else if (message.type === 'cancelled') {
        finish()
        reject(new DOMException('생성이 취소되었습니다.', 'AbortError'))
      } else if (message.type === 'error') {
        finish()
        reject(new Error(message.message))
      }
    })
    worker.addEventListener('error', (event) => {
      finish()
      reject(new Error(event.message || '미로 생성 Worker가 중단되었습니다.'))
    })
    worker.postMessage({ type: 'generate', requestId, payload })
  })
}

export function App() {
  const [route, setRouteState] = useState<Route>('loading')
  const [craftMode, setCraftMode] = useState<CraftMode>('free')
  const [project, setProjectState] = useState<MazeProject | null>(null)
  const [waterProject, setWaterProject] = useState<MazeProject | null>(null)
  const [projects, setProjects] = useState<MazeProject[]>([])
  const [machine, dispatch] = useReducer(
    (snapshot: MachineSnapshot, event: AppEvent) => transitionAppState(snapshot, event),
    initialMachineSnapshot,
  )
  const [saveStatus, setSaveStatus] = useState<AutosaveStatus>({ state: 'idle' })
  const [generationProgress, setGenerationProgress] = useState<{ completed: number; total: number } | null>(null)
  const [generationTrace, setGenerationTrace] = useState<MazeGenerationTraceStep[]>([])
  const [shareOpen, setShareOpen] = useState(false)
  const [shareMode, setShareMode] = useState<'play' | 'water'>('play')
  const [exportProject, setExportProject] = useState<MazeProject | null>(null)
  const [infoTab, setInfoTab] = useState<InfoTab | null>(null)
  const [sharedPlay, setSharedPlayState] = useState(false)
  const [sharedSolution, setSharedSolution] = useState<CellPosition[] | null>(null)
  const [recordCreator, setRecordCreator] = useState(false)
  const [theme, setTheme] = useState<ColorTheme>(() => readSettings().theme)
  const [systemDark, setSystemDark] = useState(prefersDark)
  const [qualityPreference, setQualityPreference] = useState<EffectQuality>(() => readSettings().effectQuality)
  const [storageVolatile, setStorageVolatile] = useState(false)
  // Today's maze: the day being played, its record, and a preview for the home.
  const [daily, setDaily] = useState<string | null>(null)
  const [dailyRecord, setDailyRecord] = useState(readDailyRecord)
  const [dailyPreview, setDailyPreview] = useState<MazeProject | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const cancelGenerationRef = useRef<() => void>(() => undefined)
  const toastId = useRef(0)
  const toastRef = useRef<(message: string, error?: boolean) => void>(() => undefined)
  const lastSaveErrorToast = useRef(0)
  const lastHref = useRef('')
  const navigationId = useRef(0)
  // Navigation reads these between renders, so each setter updates its ref at once.
  const routeRef = useRef<Route>(route)
  const projectRef = useRef(project)
  const sharedPlayRef = useRef(sharedPlay)
  const setRoute = useCallback((next: Route) => { routeRef.current = next; setRouteState(next) }, [])
  const setProject = useCallback((next: MazeProject | null) => { projectRef.current = next; setProjectState(next) }, [])
  const setSharedPlay = useCallback((next: boolean) => { sharedPlayRef.current = next; setSharedPlayState(next) }, [])
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  // Re-read whenever the home is shown (a stage cleared in the studio counts at
  // once) and after a backup is restored.
  const [restores, setRestores] = useState(0)
  // route and restores are not read inside; they mark when the stored stars may have changed.
  const campaign = useMemo(() => summarizeCampaign(), [route, restores])
  const today = dailyKey()
  const dailyCard = useMemo(() => ({
    info: dailyInfo(today), preview: dailyPreview?.id === `daily-${today}` ? dailyPreview : null,
    best: dailyRecord.best[today] ?? null, streak: dailyStreak(dailyRecord, today),
  }), [today, dailyPreview, dailyRecord])
  // Build today's maze for the home preview after the home has painted.
  useEffect(() => {
    if (route !== 'home' || dailyPreview?.id === `daily-${today}`) return
    const timer = window.setTimeout(() => {
      try { setDailyPreview(createDailyMaze(today)) } catch { /* The card works without a preview. */ }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [route, today, dailyPreview])
  const studioQuality = useMemo(() => resolveStudioQuality(qualityPreference), [qualityPreference])
  const autosave = useMemo(
    () =>
      createAutosave(localProjectRepository, (status) => {
        setSaveStatus(status)
        // Every failed attempt shows in the studio header; explain it now and then.
        if (status.state === 'error' && Date.now() - lastSaveErrorToast.current > SAVE_ERROR_TOAST_INTERVAL_MS) {
          lastSaveErrorToast.current = Date.now()
          toastRef.current(describeStorageError(status.error), true)
        }
      }),
    [],
  )

  const toast = useCallback((message: string, error = false) => {
    const item = { id: ++toastId.current, message, error }
    setToasts((items) => [...items, item].slice(-3))
    window.setTimeout(
      () => setToasts((items) => items.filter((candidate) => candidate.id !== item.id)),
      error ? 6000 : 3500,
    )
  }, [])
  toastRef.current = toast

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await service.all())
    } catch {
      toast('저장한 미로 목록을 불러오지 못했습니다.', true)
    }
  }, [toast])

  const checkStorage = useCallback(async () => {
    if (!(await localProjectRepository.isPersistent())) setStorageVolatile(true)
  }, [])

  /** Leaving the maze studio: save its last edit and let the water garden show it. */
  const leaveStudio = async () => {
    cancelGenerationRef.current()
    await autosave.flush()
    const current = projectRef.current
    if (current && !sharedPlayRef.current) {
      setWaterProject(current)
      rememberWaterSelection(current.id)
    }
  }

  /** Open today's maze to play; it is never saved to the collection. */
  const startDaily = () => {
    const key = dailyKey()
    const next = dailyPreview?.id === `daily-${key}` ? dailyPreview : createDailyMaze(key)
    // The home card shows the same maze on the way back without building it again.
    if (next !== dailyPreview) setDailyPreview(next)
    setProject(next)
    setSharedPlay(true)
    setSharedSolution(null)
    setRecordCreator(false)
    setDaily(key)
  }

  /** Arrive at a screen; the address bar is already pointing at it. */
  const enter = async (target: AppLocation) => {
    const id = ++navigationId.current
    const from = routeRef.current
    setShareOpen(false)
    setExportProject(null)
    setInfoTab(null)
    if (from === 'studio' && target.screen !== 'studio' && target.screen !== 'play') await leaveStudio()
    if (sharedPlayRef.current && target.screen !== 'play') {
      setSharedPlay(false)
      setSharedSolution(null)
      setProject(null)
      setWaterProject(null)
      setDaily(null)
    }
    if (target.screen === 'play' && target.daily) startDaily()
    if (target.screen === 'home') {
      setGenerationTrace([])
      await refreshProjects()
    }
    if (id !== navigationId.current) return
    if ((target.screen === 'studio' || target.screen === 'play') && !projectRef.current) {
      // Nothing to show (e.g. Forward after the project was closed).
      history.replaceState(null, '', baseUrl())
      lastHref.current = location.href
      await refreshProjects()
      setRoute('home')
      return
    }
    if (target.screen === 'craft') {
      setCraftMode(target.craftMode ?? 'free')
    } else if (target.screen === 'studio') {
      dispatch({ type: 'STOP' })
    } else if (target.screen === 'play') {
      dispatch({ type: 'PLAY' })
    }
    setRoute(target.screen)
  }

  /**
   * Show a screen and record it in the address bar. Returning to the screen
   * this one was opened from steps back in history instead of stacking a copy,
   * so the browser's Back button and the app's own links agree.
   */
  const navigate = (target: AppLocation, options: { replace?: boolean } = {}) => {
    const hash = hashFor(target)
    const entry = readHistoryState()
    if (!options.replace && entry?.document === DOCUMENT_ID && entry.fromHash === hash && location.hash !== hash) {
      history.back()
      return
    }
    if (location.hash !== hash) {
      const current = parseLocation(location.hash)
      if (options.replace) {
        history.replaceState(entry, '', baseUrl() + hash)
      } else {
        // A shared link stays in the address only while it is on screen; the
        // entry left behind reopens the same screen without re-importing it.
        const fromHash = current.shared ? hashFor(current) : location.hash
        if (current.shared) history.replaceState(entry, '', baseUrl() + fromHash)
        history.pushState({ mazecraft: 1, fromHash, document: DOCUMENT_ID } satisfies HistoryEntryState, '', baseUrl() + hash)
      }
    }
    lastHref.current = location.href
    void enter(target)
  }

  /** Open the shared maze in the address. Returns false when there is none. */
  const openShared = (isActive: () => boolean = () => true): boolean => {
    try {
      const payload = readShareHash()
      if (!payload) return false
      const isWaterShare = readShareRoute() === 'water'
      // A water scene is editable immediately. Give an incoming shared
      // project a fresh local identity so saving never overwrites an
      // existing project that happened to carry the original share ID.
      const shared = migrateProject(isWaterShare ? { ...payload.project, id: undefined } : payload.project)
      if (!isActive()) return true
      setProject(shared)
      if (isWaterShare) setWaterProject(shared)
      setSharedPlay(!isWaterShare)
      setSharedSolution(payload.solutionPath ?? null)
      setRecordCreator(false)
      setShareOpen(false)
      setExportProject(null)
      dispatch({ type: 'OPEN' })
      setRoute(isWaterShare ? 'water' : 'play')
      return true
    } catch (error) {
      toast(error instanceof Error ? error.message : '공유 링크를 읽을 수 없습니다.', true)
      history.replaceState(null, '', baseUrl())
      lastHref.current = location.href
      return false
    }
  }

  // Back, Forward, an edited address or a pasted share link.
  const followAddress = async () => {
    if (location.href === lastHref.current || routeRef.current === 'loading') return
    lastHref.current = location.href
    const target = parseLocation(location.hash)
    if (target.shared) {
      if (routeRef.current === 'studio') await leaveStudio()
      if (openShared()) return
      void enter({ screen: 'home' })
      return
    }
    if (target.screen === 'home' && location.hash.startsWith('#/') && location.hash !== hashFor(target)) {
      // An address this version does not know opens the home under its own address.
      history.replaceState(history.state, '', baseUrl() + hashFor(target))
      lastHref.current = location.href
    }
    void enter(target)
  }
  const followAddressRef = useRef(followAddress)
  followAddressRef.current = followAddress

  useEffect(() => {
    const onAddressChange = () => void followAddressRef.current()
    window.addEventListener('popstate', onAddressChange)
    window.addEventListener('hashchange', onAddressChange)
    return () => {
      window.removeEventListener('popstate', onAddressChange)
      window.removeEventListener('hashchange', onAddressChange)
    }
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      const target = parseLocation(location.hash)
      lastHref.current = location.href
      if (target.daily) {
        startDaily()
        dispatch({ type: 'PLAY' })
        setRoute('play')
        void checkStorage()
        return
      }
      if (openShared(() => active)) {
        void checkStorage()
        return
      }
      let saved: MazeProject[] = []
      let recovered: MazeProject | null = null
      try {
        ;[saved, recovered] = await Promise.all([service.all(), service.recoverLast()])
      } catch {
        toast('저장한 미로를 불러오지 못했습니다. 새로고침해 보세요.', true)
      }
      if (!active) return
      setProjects(saved)
      void checkStorage()
      if (recovered) {
        setProject(recovered)
        if (isLastWaterSelection(recovered.id)) setWaterProject(recovered)
        dispatch({ type: 'OPEN' })
      }
      // A reload returns to the screen in the address; the home is the default.
      if (target.screen === 'water') {
        setRoute('water')
      } else if (target.screen === 'craft') {
        setCraftMode(target.craftMode ?? 'free')
        setRoute('craft')
      } else if ((target.screen === 'studio' || target.screen === 'play') && recovered) {
        if (target.screen === 'play') dispatch({ type: 'PLAY' })
        setRoute(target.screen)
      } else {
        // Anything else opens the home: a studio address with no project, or
        // a screen this version no longer has (e.g. an old #/tripothon link).
        const homeHash = target.screen === 'home' ? hashFor(target) : ''
        if (location.hash.startsWith('#/') && location.hash !== homeHash) {
          history.replaceState(null, '', baseUrl() + homeHash)
          lastHref.current = location.href
        }
        setRoute('home')
      }
    })()
    return () => {
      active = false
    }
    // The boot reads the address once; later changes arrive through followAddress.
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const change = () => setSystemDark(media.matches)
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    themeColor?.setAttribute('content', dark ? '#0f171a' : '#f4f2ec')
  }, [dark])

  useEffect(
    () => () => {
      cancelGenerationRef.current()
      autosave.dispose()
    },
    [autosave],
  )

  const changeProject = useCallback(
    (next: MazeProject) => {
      setProject(next)
      updateSettings({ lastProjectId: next.id })
      autosave.schedule(next)
    },
    [autosave],
  )

  const createProject = async (template: ProjectTemplate) => {
    dispatch({ type: 'NEW_PROJECT' })
    let next: MazeProject
    try {
      next = createProjectFromTemplate(template)
    } catch (error) {
      dispatch({ type: 'STOP' })
      toast(error instanceof Error ? error.message : '새 미로를 만들지 못했습니다.', true)
      return
    }
    try {
      await service.save(next, false)
    } catch (error) {
      // The studio still opens; its autosave keeps retrying and shows the state.
      toast(describeStorageError(error), true)
    }
    setProject(next)
    setGenerationTrace([])
    dispatch({ type: 'OPEN' })
    navigate({ screen: 'studio' })
  }

  const openProject = (next: MazeProject) => {
    setProject(next)
    setGenerationTrace([])
    updateSettings({ lastProjectId: next.id })
    dispatch({ type: 'OPEN' })
    navigate({ screen: 'studio' })
  }

  const openWaterProject = (next: MazeProject) => {
    setProject(next)
    setWaterProject(next)
    setGenerationTrace([])
    updateSettings({ lastProjectId: next.id })
    rememberWaterSelection(next.id)
    dispatch({ type: 'OPEN' })
    navigate({ screen: 'water' })
  }

  const rememberWaterProject = useCallback((next: MazeProject) => {
    setProject(next)
  }, [])

  const editWaterProject = async (next: MazeProject) => {
    try {
      await service.save(next, false)
      rememberWaterSelection(next.id)
      openProject(next)
    } catch (error) {
      toast(describeStorageError(error), true)
    }
  }

  const saveWaterProject = async (next: MazeProject) => {
    try {
      await service.save(next, false)
    } catch (error) {
      toast(describeStorageError(error), true)
      throw error
    }
    rememberWaterSelection(next.id)
    await refreshProjects()
    toast('미로를 저장했습니다.')
  }

  const generateProject = useCallback(
    async (base?: MazeProject) => {
      const source = base ?? project
      if (!source) return false
      dispatch({ type: 'GENERATE' })
      setGenerationProgress({ completed: 0, total: 1 })
      try {
        const prepared = await prepareImageMaskProject(source)
        const mask = prepared.shape.kind === 'image' ? prepared.mask : createProjectMask(prepared)
        const candidate = await candidateWithWorker(
          prepared,
          mask,
          (completed, total) => setGenerationProgress({ completed, total }),
          (cancel) => {
            cancelGenerationRef.current = cancel
          },
        )
        const next = applyMazeCandidate(prepared, mask, candidate)
        setGenerationTrace(candidate.generationTrace)
        changeProject(next)
        dispatch({ type: 'GENERATED' })
        return true
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          dispatch({ type: 'STOP' })
        } else {
          const message = error instanceof Error ? error.message : '미로를 생성하지 못했습니다.'
          dispatch({ type: 'FAIL', message })
          toast(message, true)
        }
        return false
      } finally {
        setGenerationProgress(null)
        cancelGenerationRef.current = () => undefined
      }
    },
    [changeProject, project, toast],
  )

  const cancelGeneration = () => {
    cancelGenerationRef.current()
    setGenerationProgress(null)
  }

  const duplicate = async (source: MazeProject) => {
    try {
      const copy = await service.duplicate(source)
      await refreshProjects()
      openProject(copy)
    } catch (error) {
      toast(describeStorageError(error), true)
    }
  }

  const remove = async (source: MazeProject) => {
    try {
      if (await service.remove(source)) {
        await refreshProjects()
        toast('프로젝트를 삭제했습니다.')
      }
    } catch {
      toast('프로젝트를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.', true)
    }
  }

  /** A project file opens in the studio; a full backup is restored into the collection. */
  const importFile = async (file: File) => {
    try {
      if (file.size <= MAX_BACKUP_FILE_SIZE && looksLikeBackup(await readFileHead(file, 512))) {
        const { describeRestore, parseBackup, restoreBackup } = await import('../features/backup/backup')
        const backup = parseBackup(await readFileHead(file, file.size))
        if (backup) {
          const summary = await restoreBackup(backup, localProjectRepository)
          await refreshProjects()
          // Restored stars and daily days show on the home at once.
          setDailyRecord(readDailyRecord())
          setRestores((count) => count + 1)
          toast(describeRestore(summary), summary.invalid > 0 && summary.added + summary.updated === 0)
          return
        }
      }
      const imported = await service.import(file)
      await refreshProjects()
      openProject(imported)
    } catch (error) {
      if (isChunkLoadError(error)) toast('앱이 업데이트되었습니다. 새로고침한 뒤 다시 시도해 주세요.', true)
      else toast(error instanceof Error ? error.message : '파일을 열 수 없습니다.', true)
    }
  }

  const home = async () => {
    if (sharedPlayRef.current) {
      // A shared link's entry is replaced: Back then leaves for wherever the link came from.
      navigate({ screen: 'home' }, { replace: true })
      return
    }
    navigate({ screen: 'home' })
  }

  const openWater = () => {
    // The hub's door opens the water garden's own collection.
    setWaterProject(null)
    navigate({ screen: 'water' })
  }

  const openCraft = (mode: CraftMode) => {
    setCraftMode(mode)
    navigate({ screen: 'craft', craftMode: mode })
  }

  const play = (record = false) => {
    if (!project) return
    dispatch({ type: 'PLAY' })
    setRecordCreator(record)
    setSharedPlay(false)
    setSharedSolution(null)
    navigate({ screen: 'play' })
  }

  const openDaily = () => navigate({ screen: 'play', daily: true })

  const finishDaily = useCallback((elapsedMs: number) => {
    if (daily) setDailyRecord(recordDailyFinish(daily, elapsedMs))
  }, [daily])

  const exitPlay = () => {
    if (daily) {
      // Back to where today's maze was opened from (normally the home).
      navigate({ screen: 'home' })
      return
    }
    if (sharedPlay) {
      void home()
      return
    }
    dispatch({ type: 'STOP' })
    navigate({ screen: project ? 'studio' : 'home' })
  }

  const saveCreatorReplay = (replay: CreatorReplay) => {
    if (!project) return
    changeProject({ ...project, creatorReplay: replay, updatedAt: new Date().toISOString() })
    toast('제작자 고스트 기록을 저장했습니다.')
  }

  const remix = async (source: MazeProject) => {
    try {
      const next = createRemixProject(source)
      await service.save(next, false)
      setSharedPlay(false)
      setSharedSolution(null)
      setRecordCreator(false)
      setDaily(null)
      setProject(next)
      setGenerationTrace([])
      dispatch({ type: 'OPEN' })
      navigate({ screen: 'studio' }, { replace: true })
      toast('원본을 보존한 리믹스 프로젝트를 만들었습니다.')
    } catch (error) {
      toast(error instanceof Error ? error.message : '리믹스를 만들 수 없습니다.', true)
    }
  }

  const changeTheme = (next: ColorTheme) => {
    setTheme(next)
    updateSettings({ theme: next })
  }

  const toggleTheme = () => changeTheme(dark ? 'light' : 'dark')

  const changeQuality = (next: EffectQuality) => {
    setQualityPreference(next)
    updateSettings({ effectQuality: next })
  }

  const openInfo = (tab: InfoTab = 'help') => setInfoTab(tab)
  // Stable close handlers keep the dialogs' focus management from re-running on every render.
  const closeShare = useCallback(() => setShareOpen(false), [])
  const closeExport = useCallback(() => setExportProject(null), [])
  const closeInfo = useCallback(() => setInfoTab(null), [])

  const valid = project
    ? validateMaze(project.mazeGraph, project.startCell, project.endCell).valid
    : false

  if (route === 'loading') {
    return <main className="loading-screen" aria-live="polite"><BrandMark size={40} /><strong>MazeCraft</strong><p>작업 공간을 여는 중…</p></main>
  }

  return (
    <>
      <ErrorBoundary resetKey={route} onHome={() => void home()}>
        {route === 'water' && (
          <Suspense fallback={<RouteFallback label="물의 정원을 여는 중…" />}>
            <WaterStudio
              initialProject={waterProject}
              onProjectChange={rememberWaterProject}
              onLibrary={() => { setWaterProject(project); navigate({ screen: 'home', library: true }) }}
              onHome={() => { setWaterProject(project); navigate({ screen: 'home' }) }}
              onEdit={(next) => { void editWaterProject(next) }}
              onSave={saveWaterProject}
              onShare={(next) => { setProject(next); setShareMode('water'); setShareOpen(true) }}
              onCraft={() => openCraft('free')}
              onHelp={() => openInfo('help')}
              quality={studioQuality}
            />
          </Suspense>
        )}
        {route === 'craft' && (
          <Suspense fallback={<RouteFallback label="물길 크래프트를 여는 중…" />}>
            <CraftStudio initialMode={craftMode}
              onModeChange={(mode) => { setCraftMode(mode); navigate({ screen: 'craft', craftMode: mode }, { replace: true }) }}
              onHome={() => navigate({ screen: 'home' })}
              onWater={() => navigate({ screen: 'water' })}
              onHelp={() => openInfo('help')}
              quality={studioQuality} />
          </Suspense>
        )}
        {route === 'home' && (
          <HomeScreen
            projects={projects}
            onCreate={(template) => void createProject(template)}
            onOpen={openWaterProject}
            onEdit={openProject}
            onWater={openWater}
            onCraft={() => openCraft('free')}
            onChallenges={() => openCraft('challenge')}
            challenge={campaign}
            daily={dailyCard}
            onDaily={openDaily}
            onDuplicate={(source) => void duplicate(source)}
            onDelete={(source) => void remove(source)}
            onExport={(source) => setExportProject(source)}
            onImport={(file) => void importFile(file)}
            onThemeToggle={toggleTheme}
            onInfo={openInfo}
            storageVolatile={storageVolatile}
            dark={dark}
          />
        )}
        {route === 'studio' && project && (
          <Suspense fallback={<RouteFallback label="미로 제작실을 여는 중…" />}>
            <StudioScreen
              project={project}
              state={machine.value}
              saveStatus={saveStatus}
              generationProgress={generationProgress}
              generationTrace={generationTrace}
              onChange={changeProject}
              onGenerate={generateProject}
              onCancelGeneration={cancelGeneration}
              onPlay={play}
              onHome={() => void home()}
              onShare={() => { setShareMode('play'); setShareOpen(true) }}
              onExport={() => setExportProject(project)}
              onThemeToggle={toggleTheme}
              dark={dark}
              onToast={toast}
            />
          </Suspense>
        )}
        {route === 'play' && project && (
          <Suspense fallback={<RouteFallback label="플레이를 준비하는 중…" />}>
            <PlayerScreen
              key={daily ?? project.id}
              project={project}
              shared={sharedPlay}
              daily={daily ? {
                info: dailyInfo(daily),
                streak: dailyStreak(dailyRecord, daily),
                // Counted as if today were finished, so the clear card is right from its first paint.
                finishedStreak: dailyStreak({ best: { ...dailyRecord.best, [daily]: 1 } }, daily),
                best: dailyRecord.best[daily] ?? null,
              } : undefined}
              onFinish={daily ? finishDaily : undefined}
              allowSolution={!sharedPlay || Boolean(sharedSolution?.length)}
              recordCreator={recordCreator}
              onExit={exitPlay}
              onRemix={(source) => void remix(source)}
              onCreatorReplay={saveCreatorReplay}
            />
          </Suspense>
        )}
      </ErrorBoundary>
      <ErrorBoundary resetKey={`${shareOpen}-${exportProject?.id}-${infoTab}`} fallback={() => <DialogFailure onClose={() => { setShareOpen(false); setExportProject(null); setInfoTab(null) }} />}>
        {shareOpen && project && (
          <Suspense fallback={null}>
            <ShareDialog project={project} valid={valid} mode={shareMode} onClose={closeShare} />
          </Suspense>
        )}
        {exportProject && (
          <Suspense fallback={null}>
            <ExportDialog
              project={exportProject}
              valid={validateMaze(exportProject.mazeGraph, exportProject.startCell, exportProject.endCell).valid}
              onClose={closeExport}
            />
          </Suspense>
        )}
        {infoTab && (
          <Suspense fallback={null}>
            <InfoDialog
              initialTab={infoTab}
              onClose={closeInfo}
              theme={theme}
              onThemeChange={changeTheme}
              quality={qualityPreference}
              onQualityChange={changeQuality}
              storageVolatile={storageVolatile}
              projectCount={projects.length}
              onRestore={(file) => importFile(file)}
              onToast={toast}
            />
          </Suspense>
        )}
      </ErrorBoundary>
      <div className="toast-region" aria-live="polite">
        {toasts.map((item) => <div key={item.id} className={`toast ${item.error ? 'error' : ''}`}>{item.message}</div>)}
      </div>
    </>
  )
}

function DialogFailure({ onClose }: { onClose: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="alertdialog" aria-labelledby="dialog-failure-title">
        <header className="dialog-header"><h2 id="dialog-failure-title">창을 열지 못했습니다</h2></header>
        <div className="dialog-body"><p>잠시 후 다시 시도하거나 페이지를 새로고침해 주세요. 작업 내용은 그대로 저장되어 있습니다.</p></div>
        <footer className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose}>닫기</button>
          <button className="button" type="button" onClick={() => window.location.reload()}>새로고침</button>
        </footer>
      </section>
    </div>
  )
}
