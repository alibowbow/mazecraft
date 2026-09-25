import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Blocks, Castle, ChartBarDecreasing, ChevronDown, Cog, Cylinder, Drill, Droplets, Expand, Fan,
  Flower2, Grid3x3, Link, Maximize2, Minus, Pause, Play, Plus, RotateCcw, Shuffle, Spline, Tornado, Trash2, Video, Waves, X, type LucideIcon,
} from 'lucide-react'
import { BrandMark } from '../../components/BrandMark'
import { FreeSurfaceRuntime, type FreeSurfaceStatus } from '../waterSimulation/freeSurface/runtime'
import { AQUA_WATER_APPEARANCE } from '../waterSimulation/freeSurface/appearance'
import { DEFAULT_WATER_LOOK, STUDIO_BACKGROUND } from '../waterSimulation/freeSurface/lookdev'
import { createWaterStudioProject } from '../waterStudio/presets'
import {
  compileCraft, CRAFT_EXITS, CRAFT_MODULES, craftModule, craftTemplates, hasSpout,
  type CraftCourse, type CraftExit, type CraftKind, type CraftModule, type CraftSize, type CraftTurn,
} from '../waterSimulation/garden/craft'
import { registerGardenDesign } from '../waterSimulation/garden/layout'
import type { GardenSculpture } from '../waterSimulation/garden'
import '../waterStudio/waterStudio.css'
import './craft.css'

const STORAGE_KEY = 'mazecraft.craft.v1'

const ICONS: Record<CraftKind, LucideIcon> = {
  maze: Grid3x3, terraces: ChartBarDecreasing, pond: Flower2, noria: Cog, screw: Drill,
  spiral: Tornado, zigzag: Spline, aqueduct: Castle, siphon: Cylinder,
}
const EXIT_ICONS: Record<CraftExit, LucideIcon> = { plain: Droplets, tipper: Link, wheel: Fan, chain: Link }
const CATEGORY_NAMES = { basin: '수조', lift: '양수 장치', channel: '수로', special: '특수 장치' } as const

function readCourse(): CraftCourse {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as CraftCourse | null
    const kinds = new Set(CRAFT_MODULES.map(item => item.kind))
    if (stored && stored.version === 1 && Array.isArray(stored.modules) && stored.modules.every(item => kinds.has(item.kind))) {
      return { ...stored, source: Math.max(2.5, Math.min(6.5, Number(stored.source) || 4.3)), modules: stored.modules.slice(0, 12) }
    }
  } catch { /* Storage may be disabled. */ }
  return craftTemplates()[1].course
}

/** A short, stable key for a course, so an unchanged course keeps its garden. */
function courseKey(course: CraftCourse): `craft-${string}` {
  const text = JSON.stringify({ s: course.source, m: course.modules.map(({ kind, turn, exit, size, seed, wheels }) => [kind, turn, exit, size, seed, wheels]) })
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return `craft-${(h >>> 0).toString(36)}`
}

interface Props {
  onHome(): void
  onWater(): void
}

export default function CraftStudio({ onHome, onWater }: Props) {
  const [course, setCourse] = useState<CraftCourse>(readCourse)
  const [open, setOpen] = useState<string | null>(null)
  const result = useMemo(() => compileCraft(course), [course])
  // Which devices still fit at the end of a working course.
  const fits = useMemo(() => {
    if (result.issues.length || !course.modules.length) return null
    return new Set(CRAFT_MODULES.filter(info => !compileCraft({ ...course, modules: [...course.modules, craftModule(info.kind, { id: 'probe', seed: 1 })] }).issues.length).map(info => info.kind))
  }, [course, result])
  const [shown, setShown] = useState<`craft-${string}` | null>(null)
  const [paused, setPaused] = useState(true)
  const [inflow, setInflow] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [flow, setFlow] = useState(1)
  const [follow, setFollow] = useState(false)
  const [focus, setFocus] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [renderState, setRenderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [status, setStatus] = useState<FreeSurfaceStatus | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const mountRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<FreeSurfaceRuntime | null>(null)
  const project = useMemo(() => createWaterStudioProject('atelier'), [])
  const issue = result.issues[0]

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(course)) } catch { /* Storage may be disabled. */ }
  }, [course])
  // A course that works replaces the garden on show, after a short pause
  // so quick edits do not rebuild it at every click.
  useEffect(() => {
    if (!result.design) return
    const key = courseKey(course)
    registerGardenDesign(key, result.design)
    const timer = setTimeout(() => setShown(key), shown ? 450 : 0)
    return () => clearTimeout(timer)
  }, [result, course])
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !shown) return
    let disposed = false
    let runtime: FreeSurfaceRuntime | null = null
    setRenderState('loading'); setStatus(null); setPaused(true); setInflow(true)
    try {
      runtime = new FreeSurfaceRuntime(mount, project, 'high', 'natural',
        () => { if (!disposed) setRenderState('ready') },
        next => { if (!disposed) setStatus(next) },
        message => { if (!disposed) { setError(message); setRenderState('error') } },
        () => undefined, false, `garden:${shown}` as GardenSculpture)
      runtime.setLook(DEFAULT_WATER_LOOK)
      runtime.setViewMode('surface-3d')
      runtime.setAppearance({ color: AQUA_WATER_APPEARANCE.color, profile: 'aqua', opacity: 0.72 })
      runtime.setInflowRate(flow)
      runtime.setSpeed(speed)
      runtime.setPaused(true)
      runtime.setFollow(follow)
      runtimeRef.current = runtime
    } catch (reason) {
      runtime?.dispose()
      mount.replaceChildren()
      setError(reason instanceof Error ? reason.message : '물길을 시작할 수 없습니다.')
      setRenderState('error')
    }
    return () => { disposed = true; runtime?.dispose(); if (runtimeRef.current === runtime) runtimeRef.current = null }
  }, [shown, retry])
  useEffect(() => { runtimeRef.current?.setSpeed(speed) }, [speed])
  useEffect(() => { runtimeRef.current?.setInflowRate(flow) }, [flow])
  useEffect(() => { runtimeRef.current?.setFollow(follow) }, [follow])

  const update = (id: string, change: Partial<CraftModule>) => setCourse(previous => ({ ...previous, modules: previous.modules.map(item => item.id === id ? { ...item, ...change } : item) }))
  const move = (index: number, by: number) => setCourse(previous => {
    const modules = previous.modules.slice(), target = index + by
    if (target < 0 || target >= modules.length) return previous
    ;[modules[index], modules[target]] = [modules[target], modules[index]]
    return { ...previous, modules }
  })
  const remove = (id: string) => setCourse(previous => ({ ...previous, modules: previous.modules.filter(item => item.id !== id) }))
  const add = (kind: CraftKind) => {
    const next = craftModule(kind)
    setCourse(previous => ({ ...previous, modules: [...previous.modules, next].slice(0, 12) }))
    setOpen(next.id)
  }
  const togglePlayback = () => { runtimeRef.current?.setPaused(!paused); setPaused(!paused) }
  const toggleInflow = () => { runtimeRef.current?.setInflow(!inflow); setInflow(!inflow) }
  const restart = () => { runtimeRef.current?.restart(); setPaused(true); setInflow(true) }
  const stageOf = (index: number) => result.stages.find(stage => stage.module === index)
  const sceneLabel = paused ? '일시정지' : !inflow ? '배수 중' : status?.reachedExit ? '흐르는 중' : '물을 붓는 중'
  const working = !issue && result.design

  return <main className={`water-studio craft-studio${focus ? ' is-focused' : ''}${panelOpen ? ' tuning-open' : ''}`} data-testid="craft-studio"
    style={{ '--ws-scene': STUDIO_BACKGROUND } as CSSProperties}>
    <header className="ws-header">
      <button className="ws-brand" aria-label="메이즈크래프트 홈" onClick={onHome}><BrandMark /><div><strong>MAZECRAFT</strong><span>WATER CRAFT</span></div></button>
      <nav className="ws-navigation" aria-label="주 메뉴"><button onClick={onHome}>홈</button><button onClick={onWater}>물의 정원</button><span aria-current="page">크래프트</span></nav>
      <div className="ws-header-actions">
        <button className="ws-icon" aria-label="몰입 화면" aria-pressed={focus} onClick={() => setFocus(!focus)}>{focus ? <X size={19} /> : <Expand size={19} />}</button>
      </div>
    </header>
    <div className="ws-workspace">
      <section className="ws-view" aria-label="크래프트 물길 작업 공간">
        <div className="ws-scene-heading"><span className="ws-eyebrow">WATER CRAFT / {course.modules.length} DEVICES</span><h1>{course.name || '나의 물길'}</h1><p>장치를 이어 붙여 물이 흐를 길을 짓습니다</p></div>
        <div className="ws-status"><i className={paused ? 'is-paused' : ''} />{renderState === 'ready' ? sceneLabel : renderState === 'error' ? '실행 오류' : '준비 중'}</div>
        <div className="ws-canvas" ref={mountRef} data-testid="craft-canvas" data-renderer={renderState} data-garden={shown ?? ''} />
        {renderState === 'ready' && paused && !(status?.simulationTime) && <button className="ws-start" onClick={togglePlayback}><Play size={18} fill="currentColor" /><span>물 흘려보내기</span></button>}
        {renderState === 'loading' && <div className="ws-stage-message" role="status"><Blocks size={30} /><span>{shown ? '물길을 짓고 있습니다' : '장치를 이어 물길을 만들어 주세요'}</span></div>}
        {renderState === 'error' && <div className="ws-stage-message" role="alert"><strong>화면을 시작하지 못했습니다</strong><p>{error}</p><button onClick={() => setRetry(n => n + 1)}>다시 시작</button></div>}
        {issue && shown && <div className="craft-stale" role="status">바뀐 물길에 문제가 있어 이전 물길을 보여주고 있어요</div>}
        <div className="ws-control-dock">
          <div className="ws-view-controls">
            <button className="ws-icon" aria-label="축소" onClick={() => runtimeRef.current?.zoomCamera(1 / 1.2)}><Minus size={17} /></button>
            <button className="ws-icon" aria-label="확대" onClick={() => runtimeRef.current?.zoomCamera(1.2)}><Plus size={17} /></button>
            <button className="ws-icon" aria-label="시점 초기화" onClick={() => runtimeRef.current?.resetCamera()}><Maximize2 size={17} /></button>
            <button className="ws-icon" aria-label="물 추적 모드" title="물 추적 모드" aria-pressed={follow} onClick={() => setFollow(!follow)}><Video size={17} /></button>
          </div>
          <div className="ws-transport">
            <button className="ws-play" aria-label={paused ? '재생' : '일시정지'} disabled={renderState !== 'ready'} onClick={togglePlayback}>{paused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}</button>
            <button className="ws-icon" aria-label="물 다시 붓기" disabled={renderState !== 'ready'} onClick={restart}><RotateCcw size={19} /></button>
            <label className="ws-speed"><span className="sr-only">재생 속도</span><select aria-label="재생 속도" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select><ChevronDown size={13} /></label>
            <span className="ws-transport-divider" />
            <button className="ws-pour" aria-label={inflow ? '물 붓기 켜짐' : '물 붓기 꺼짐'} aria-pressed={inflow} onClick={toggleInflow}><Droplets size={18} /><span>{inflow ? '물 붓기 켜짐' : '물 붓기 꺼짐'}</span></button>
            <button className="ws-mobile-tune ws-icon" aria-label="장치 목록 열기" aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}><Blocks size={18} /></button>
          </div>
        </div>
        <span className="ws-camera-hint">드래그하여 회전 · 오른쪽 버튼으로 이동 · 두 손가락으로 확대</span>
        {focus && <button className="ws-focus-exit" onClick={() => setFocus(false)}><X size={16} />몰입 화면 닫기</button>}
      </section>
      <aside className="ws-tuning craft-panel" aria-label="물길 크래프트">
        <div className="ws-panel-heading"><div><span className="ws-eyebrow">CRAFT YOUR FLOW</span><h2>물길 크래프트</h2></div><Blocks size={20} /><button className="ws-mobile-tune ws-icon" aria-label="장치 목록 닫기" onClick={() => setPanelOpen(false)}><X size={19} /></button></div>
        <div className="ws-panel-content craft-content">
          <div className={`craft-verdict${working ? ' is-working' : ' has-issue'}`} role="status" aria-live="polite" data-testid="craft-verdict">
            {working ? <><Waves size={16} /><span>물이 끝까지 흐르는 물길이에요 · 장치 {course.modules.length}개</span></> : <><X size={16} /><span>{issue ? `${issue.module >= 0 ? `${issue.module + 1}번 장치: ` : ''}${issue.message}` : '물길을 만들어 주세요'}</span></>}
          </div>

          <div className="craft-templates" role="group" aria-label="추천 조합">
            {craftTemplates().map(template => <button key={template.id} title={template.description} onClick={() => { setCourse(template.course); setOpen(null) }}>{template.name}</button>)}
          </div>

          <label className="ws-slider craft-source"><span>수원 높이<output>{course.source.toFixed(1)} m</output></span>
            <input type="range" aria-label="수원 높이" min={2.5} max={6.5} step={0.1} value={course.source} onChange={event => setCourse(previous => ({ ...previous, source: Number(event.target.value) }))} /></label>
          <label className="ws-slider craft-source"><span>유입량<output>{Math.round(flow * 40)} L/s</output></span>
            <input type="range" aria-label="유입량" min={0.25} max={2} step={0.05} value={flow} onChange={event => setFlow(Number(event.target.value))} /></label>

          <div className="ws-section-label"><span>물길 순서</span><span>WATER COURSE</span></div>
          <ol className="craft-course" aria-label="물길 순서">
            <li className="craft-anchor"><Droplets size={15} /><span>수원 탑 · {course.source.toFixed(1)} m</span></li>
            {course.modules.map((item, index) => {
              const info = CRAFT_MODULES.find(entry => entry.kind === item.kind)!
              const Icon = ICONS[item.kind]
              const stage = stageOf(index)
              const expanded = open === item.id
              const failing = issue?.module === index
              return <li key={item.id} className={`craft-step${expanded ? ' is-open' : ''}${failing ? ' has-issue' : ''}`}>
                <div className="craft-step-head">
                  <button className="craft-step-title" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : item.id)}>
                    <span className="craft-step-index">{index + 1}</span><Icon size={17} /><strong>{info.name}</strong>
                    <small>{stage ? `${stage.top.toFixed(1)} m` : ''}</small>
                  </button>
                  <div className="craft-step-actions">
                    <button aria-label={`${index + 1}번 위로`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
                    <button aria-label={`${index + 1}번 아래로`} disabled={index === course.modules.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
                    <button aria-label={`${index + 1}번 빼기`} onClick={() => remove(item.id)}><Trash2 size={14} /></button>
                  </div>
                </div>
                {expanded && <div className="craft-step-options">
                  <p>{info.description}</p>
                  {info.sizes[0] !== '—' && <div className="craft-option"><span>크기</span><div className="ws-segment" role="group" aria-label="크기">
                    {(['small', 'medium', 'large'] as CraftSize[]).map((size, k) => <button key={size} aria-pressed={item.size === size} onClick={() => update(item.id, { size })}>{info.sizes[k]}</button>)}
                  </div></div>}
                  <div className="craft-option"><span>{item.kind === 'noria' ? '수로 방향' : '나가는 방향'}</span><div className="ws-segment" role="group" aria-label="방향">
                    {(['left', 'straight', 'right'] as CraftTurn[]).filter(turn => item.kind !== 'noria' || turn !== 'straight').map(turn =>
                      <button key={turn} aria-label={{ left: '왼쪽', straight: '직진', right: '오른쪽' }[turn]} aria-pressed={item.turn === turn || (item.kind === 'noria' && turn === 'left' && item.turn === 'straight')} onClick={() => update(item.id, { turn })}>
                        {turn === 'left' ? <ArrowLeft size={14} /> : turn === 'right' ? <ArrowRight size={14} /> : <ArrowUp size={14} />}
                      </button>)}
                  </div></div>
                  {hasSpout(item.kind) && <div className="craft-option craft-exits"><span>출구 장치</span><div role="group" aria-label="출구 장치">
                    {CRAFT_EXITS.map(({ exit, name, description }) => { const ExitIcon = EXIT_ICONS[exit]; return <button key={exit} title={description} aria-pressed={item.exit === exit} onClick={() => update(item.id, { exit })}><ExitIcon size={14} />{name}</button> })}
                  </div></div>}
                  {(item.kind === 'maze' || item.kind === 'terraces') && <div className="craft-option craft-toggles">
                    <label><input type="checkbox" checked={item.wheels} onChange={event => update(item.id, { wheels: event.target.checked })} /> 둑마다 물레</label>
                    {item.kind === 'maze' && <button onClick={() => update(item.id, { seed: Math.floor(Math.random() * 1000) })}><Shuffle size={14} /> 미로 다시 섞기</button>}
                  </div>}
                </div>}
                {failing && <p className="craft-issue">{issue!.message}</p>}
              </li>
            })}
            <li className="craft-anchor"><Waves size={15} /><span>종착 연못과 배수구</span></li>
          </ol>

          <div className="ws-section-label"><span>장치 추가</span><span>DEVICES</span></div>
          {(['basin', 'lift', 'channel', 'special'] as const).map(category => <div key={category} className="craft-palette-group">
            <span className="craft-palette-label">{CATEGORY_NAMES[category]}</span>
            <div className="craft-palette">
              {CRAFT_MODULES.filter(info => info.category === category).map(info => { const Icon = ICONS[info.kind]; const short = fits !== null && !fits.has(info.kind); return <button key={info.kind} className={short ? 'is-short' : undefined} title={short ? `${info.description}\n지금 물길 끝에는 높이가 부족해요. 양수 장치를 먼저 넣어 보세요.` : info.description} aria-label={`${info.name} 추가`} disabled={course.modules.length >= 12} onClick={() => add(info.kind)}>
                <Icon size={20} /><strong>{info.name}</strong><small>{short ? '높이 부족' : info.height}</small>
              </button> })}
            </div>
          </div>)}
          <button className="craft-clear" onClick={() => { setCourse(previous => ({ ...previous, modules: [] })); setOpen(null) }}><Trash2 size={14} /> 모두 비우기</button>
        </div>
      </aside>
    </div>
  </main>
}
