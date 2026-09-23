import {
  lazy,
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
import { HomeScreen, type ProjectTemplate } from '../features/home/HomeScreen'
import { BrandMark } from '../components/BrandMark'
import { ProjectService } from '../features/projects/projectService'
import {
  createRemixProject,
  readShareHash,
  readShareRoute,
} from '../features/share'
import {
  createAutosave,
  localProjectRepository,
  readSettings,
  updateSettings,
  type AutosaveStatus,
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

type Route = 'loading' | 'water' | 'home' | 'studio' | 'play'

const WaterStudio = lazy(() => import('../features/waterStudio/WaterStudio'))

const StudioScreen = lazy(() =>
  import('../features/creator/StudioScreen').then((module) => ({
    default: module.StudioScreen,
  })),
)
const PlayerScreen = lazy(() =>
  import('../features/player/PlayerScreen').then((module) => ({
    default: module.PlayerScreen,
  })),
)
const ShareDialog = lazy(() =>
  import('../features/share/ShareDialog').then((module) => ({
    default: module.ShareDialog,
  })),
)
const ExportDialog = lazy(() =>
  import('../features/export/ExportDialog').then((module) => ({
    default: module.ExportDialog,
  })),
)

interface Toast {
  id: number
  message: string
  error: boolean
}

const service = new ProjectService(localProjectRepository)
const LAST_WATER_PROJECT_KEY = 'mazecraft.last-water-project-id'

function setLibraryLocation(open: boolean): void {
  history.replaceState(null, '', location.pathname + location.search + (open ? '#/library' : ''))
}

function rememberWaterSelection(id: string): void {
  try { localStorage.setItem(LAST_WATER_PROJECT_KEY, id) } catch { /* Optional navigation preference. */ }
}

function isLastWaterSelection(id: string): boolean {
  try { return localStorage.getItem(LAST_WATER_PROJECT_KEY) === id } catch { return false }
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

const resolveDark = () => {
  const theme = readSettings().theme
  return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
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
    const requestId = crypto.randomUUID()
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
  const [route, setRoute] = useState<Route>('loading')
  const [project, setProject] = useState<MazeProject | null>(null)
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
  const [sharedPlay, setSharedPlay] = useState(false)
  const [sharedSolution, setSharedSolution] = useState<CellPosition[] | null>(null)
  const [recordCreator, setRecordCreator] = useState(false)
  const [dark, setDark] = useState(resolveDark)
  const [toasts, setToasts] = useState<Toast[]>([])
  const cancelGenerationRef = useRef<() => void>(() => undefined)
  const toastId = useRef(0)
  const autosave = useMemo(
    () =>
      createAutosave(localProjectRepository, (status) => {
        setSaveStatus(status)
      }),
    [],
  )

  const toast = useCallback((message: string, error = false) => {
    const item = { id: ++toastId.current, message, error }
    setToasts((items) => [...items, item].slice(-3))
    window.setTimeout(() => setToasts((items) => items.filter((candidate) => candidate.id !== item.id)), 3000)
  }, [])

  const refreshProjects = useCallback(async () => {
    setProjects(await service.recent(12))
  }, [])

  useEffect(() => {
    const openLibraryFromLocation = () => {
      if (location.hash !== '#/library') return
      setRoute('home')
      void refreshProjects().catch(() => toast('저장한 미로를 불러오지 못했습니다.', true))
    }
    window.addEventListener('hashchange', openLibraryFromLocation)
    return () => window.removeEventListener('hashchange', openLibraryFromLocation)
  }, [refreshProjects, toast])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const payload = readShareHash()
        if (payload) {
          const isWaterShare = readShareRoute() === 'water'
          // A water scene is editable immediately. Give an incoming shared
          // project a fresh local identity so saving never overwrites an
          // existing project that happened to carry the original share ID.
          const shared = migrateProject(isWaterShare ? { ...payload.project, id: undefined } : payload.project)
          if (!active) return
          setProject(shared)
          if (isWaterShare) setWaterProject(shared)
          setSharedPlay(!isWaterShare)
          setSharedSolution(payload.solutionPath ?? null)
          setRecordCreator(false)
          dispatch({ type: 'OPEN' })
          setRoute(isWaterShare ? 'water' : 'play')
          return
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : '공유 링크를 읽을 수 없습니다.', true)
        history.replaceState(null, '', location.pathname + location.search)
      }
      const [recent, recovered] = await Promise.all([service.recent(12), service.recoverLast()])
      if (!active) return
      setProjects(recent)
      if (recovered) {
        setProject(recovered)
        if (isLastWaterSelection(recovered.id)) setWaterProject(recovered)
        dispatch({ type: 'OPEN' })
      }
      // MazeCraft opens on its home: the maze studio and the water garden are
      // two doors from there. A recovered project is offered on the home.
      setRoute('home')
    })()
    return () => {
      active = false
    }
  }, [toast])

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
    const next = createProjectFromTemplate(template)
    await service.save(next, false)
    setProject(next)
    setGenerationTrace([])
    dispatch({ type: 'OPEN' })
    setLibraryLocation(false)
    setRoute('studio')
  }

  const openProject = (next: MazeProject) => {
    setProject(next)
    setGenerationTrace([])
    updateSettings({ lastProjectId: next.id })
    dispatch({ type: 'OPEN' })
    setLibraryLocation(false)
    setRoute('studio')
  }

  const openWaterProject = (next: MazeProject) => {
    setProject(next)
    setWaterProject(next)
    setGenerationTrace([])
    updateSettings({ lastProjectId: next.id })
    rememberWaterSelection(next.id)
    dispatch({ type: 'OPEN' })
    setLibraryLocation(false)
    setRoute('water')
  }

  const rememberWaterProject = useCallback((next: MazeProject) => {
    setProject(next)
  }, [])

  const editWaterProject = async (next: MazeProject) => {
    try {
      await service.save(next, false)
      rememberWaterSelection(next.id)
      history.replaceState(null, '', location.pathname + location.search)
      openProject(next)
    } catch (error) {
      toast(error instanceof Error ? error.message : '미로를 저장하지 못했습니다.', true)
    }
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
    const copy = await service.duplicate(source)
    await refreshProjects()
    openProject(copy)
  }

  const remove = async (source: MazeProject) => {
    if (await service.remove(source)) {
      await refreshProjects()
      toast('프로젝트를 삭제했습니다.')
    }
  }

  const importProject = async (file: File) => {
    try {
      const imported = await service.import(file)
      await refreshProjects()
      openProject(imported)
    } catch (error) {
      toast(error instanceof Error ? error.message : '프로젝트를 열 수 없습니다.', true)
    }
  }

  const home = async () => {
    cancelGenerationRef.current()
    await autosave.flush()
    await refreshProjects()
    setShareOpen(false)
    setExportProject(null)
    if (sharedPlay) {
      history.replaceState(null, '', location.pathname + location.search)
      setSharedPlay(false)
      setSharedSolution(null)
      setProject(null)
      setWaterProject(null)
    } else if (route === 'studio' && project) {
      // The editor owns the current graph; returning to the water workspace
      // must simulate these edited walls rather than recreate a preset.
      setWaterProject(project)
      rememberWaterSelection(project.id)
    }
    setGenerationTrace([])
    setLibraryLocation(false)
    setRoute('home')
  }

  const openWater = () => {
    // The hub's door opens the water garden's own collection.
    setWaterProject(null)
    setLibraryLocation(false)
    setRoute('water')
  }

  const play = (record = false) => {
    if (!project) return
    dispatch({ type: 'PLAY' })
    setRecordCreator(record)
    setSharedPlay(false)
    setSharedSolution(null)
    setRoute('play')
  }

  const exitPlay = () => {
    if (sharedPlay) {
      void home()
      return
    }
    dispatch({ type: 'STOP' })
    setRoute(project ? 'studio' : 'home')
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
      history.replaceState(null, '', location.pathname + location.search)
      setSharedPlay(false)
      setSharedSolution(null)
      setRecordCreator(false)
      setProject(next)
      setGenerationTrace([])
      dispatch({ type: 'OPEN' })
      setRoute('studio')
      toast('원본을 보존한 리믹스 프로젝트를 만들었습니다.')
    } catch (error) {
      toast(error instanceof Error ? error.message : '리믹스를 만들 수 없습니다.', true)
    }
  }

  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    updateSettings({ theme: next ? 'dark' : 'light' })
  }

  const valid = project
    ? validateMaze(project.mazeGraph, project.startCell, project.endCell).valid
    : false

  if (route === 'loading') {
    return <main className="loading-screen" aria-live="polite"><BrandMark size={40} /><strong>MazeCraft</strong><p>프로젝트를 복구하고 있습니다…</p></main>
  }

  return (
    <>
      {route === 'water' && (
        <Suspense fallback={<RouteFallback label="물 스튜디오를 여는 중…" />}>
          <WaterStudio
            initialProject={waterProject}
            onProjectChange={rememberWaterProject}
            onLibrary={() => { setWaterProject(project); setLibraryLocation(true); void refreshProjects(); setRoute('home') }}
            onHome={() => { setWaterProject(project); setLibraryLocation(false); void refreshProjects(); setRoute('home') }}
            onEdit={(next) => { void editWaterProject(next) }}
            onSave={async (next) => { await service.save(next, false); rememberWaterSelection(next.id); await refreshProjects(); toast('미로를 저장했습니다.') }}
            onShare={(next) => { setProject(next); setShareMode('water'); setShareOpen(true) }}
          />
        </Suspense>
      )}
      {route === 'home' && (
        <HomeScreen
          projects={projects}
          onCreate={(template) => void createProject(template)}
          onOpen={openWaterProject}
          onEdit={openProject}
          onWater={openWater}
          onDuplicate={(source) => void duplicate(source)}
          onDelete={(source) => void remove(source)}
          onExport={(source) => setExportProject(source)}
          onImport={(file) => void importProject(file)}
          onThemeToggle={toggleTheme}
          dark={dark}
        />
      )}
      {route === 'studio' && project && (
        <Suspense fallback={<RouteFallback label="제작실을 여는 중…" />}>
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
            project={project}
            shared={sharedPlay}
            allowSolution={!sharedPlay || Boolean(sharedSolution?.length)}
            recordCreator={recordCreator}
            onExit={exitPlay}
            onRemix={(source) => void remix(source)}
            onCreatorReplay={saveCreatorReplay}
          />
        </Suspense>
      )}
      {shareOpen && project && (
        <Suspense fallback={null}>
          <ShareDialog project={project} valid={valid} mode={shareMode} onClose={() => setShareOpen(false)} />
        </Suspense>
      )}
      {exportProject && (
        <Suspense fallback={null}>
          <ExportDialog
            project={exportProject}
            valid={validateMaze(exportProject.mazeGraph, exportProject.startCell, exportProject.endCell).valid}
            onClose={() => setExportProject(null)}
          />
        </Suspense>
      )}
      <div className="toast-region" aria-live="polite">
        {toasts.map((item) => <div key={item.id} className={`toast ${item.error ? 'error' : ''}`}>{item.message}</div>)}
      </div>
    </>
  )
}
