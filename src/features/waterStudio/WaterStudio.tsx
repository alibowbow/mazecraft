import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowUpRight, Check, ChevronDown, Droplets, Expand, FolderOpen, Maximize2, Minus, Pause, Play, Plus, RotateCcw, Save, Shuffle, SlidersHorizontal, Waves, X, Square, Circle, Heart, Hexagon, Star, Diamond, Wand2, Pencil } from 'lucide-react'
import type { MazeProject } from '../../core/maze'
import { FreeSurfaceRuntime, type FreeSurfaceStatus } from '../waterSimulation/freeSurface/runtime'
import { WATER_COLOR_PRESETS, type WaterAppearance } from '../waterSimulation/freeSurface/appearance'
import { DEFAULT_WATER_LOOK, WATER_THEMES, normalizeWaterLook, type WaterLook } from '../waterSimulation/freeSurface/lookdev'
import type { WaterSurfaceStyle } from '../waterSimulation/rendering'
import { WATER_STUDIO_PRESETS, createWaterStudioProject, type WaterStudioPresetId } from './presets'
import { createGeneratedWaterMaze, DEFAULT_WATER_MAZE, WATER_MAZE_SHAPES, type WaterMazeOptions } from './createMaze'
import './waterStudio.css'

const STORAGE_KEY = 'mazecraft.water-studio.v1'
interface StudioPreferences {
  source: 'generated' | 'flow'; generator: WaterMazeOptions
  preset: WaterStudioPresetId; seed: string; size: number
  look: WaterLook; color: string | null; opacity: number; flow: number
  surface: WaterSurfaceStyle; speed: number
}
const defaults: StudioPreferences = {
  source: 'flow', generator: DEFAULT_WATER_MAZE,
  preset: 'atelier', seed: 'atelier-01', size: 0,
  look: DEFAULT_WATER_LOOK, color: '#16aeb7', opacity: 0.72,
  flow: 0.65, surface: 'natural', speed: 1,
}
function readPreferences(): StudioPreferences {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    const bounded = (v: unknown, low: number, high: number, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(low, Math.min(high, v)) : fallback
    const g = p.generator ?? {}
    const generator: WaterMazeOptions = {
      ...DEFAULT_WATER_MAZE,
      rows: Math.round(bounded(g.rows, 8, 32, 12)), cols: Math.round(bounded(g.cols, 8, 32, 12)),
      shape: WATER_MAZE_SHAPES.some(([id]) => id === g.shape) ? g.shape : 'rectangle',
      algorithm: ['dfs', 'prim', 'kruskal'].includes(g.algorithm) ? g.algorithm : 'kruskal',
      difficulty: ['very-easy', 'easy', 'normal', 'hard', 'expert'].includes(g.difficulty) ? g.difficulty : 'normal',
      seed: typeof g.seed === 'string' ? g.seed.slice(0, 120) : DEFAULT_WATER_MAZE.seed,
    }
    return {
      source: p.source === 'generated' ? 'generated' : p.source === 'flow' ? 'flow' : defaults.source, generator,
      preset: WATER_STUDIO_PRESETS.some(item => item.id === p.preset) ? p.preset : defaults.preset,
      seed: typeof p.seed === 'string' && p.seed.length < 120 ? p.seed : defaults.seed,
      size: [0, 6, 8, 10].includes(p.size) ? p.size : 0,
      look: normalizeWaterLook(p.look ?? defaults.look),
      color: p.color === null || (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) ? p.color : defaults.color,
      opacity: bounded(p.opacity, 0.2, 0.9, defaults.opacity), flow: bounded(p.flow, 0.1, 2.5, defaults.flow),
      surface: ['calm', 'natural', 'dynamic'].includes(p.surface) ? p.surface : defaults.surface,
      speed: [0.5, 1, 2].includes(p.speed) ? p.speed : 1,
    }
  } catch { return defaults }
}

function MazeMiniature({ project }: { project: MazeProject }) {
  const { rows, cols, cells } = project.mazeGraph
  const lines = cells.filter(cell => cell.active).flatMap(cell => {
    const { row: y, col: x, walls } = cell
    return [walls.top ? `M${x} ${y}h1` : '', walls.left ? `M${x} ${y}v1` : '', walls.right ? `M${x + 1} ${y}v1` : '', walls.bottom ? `M${x} ${y + 1}h1` : ''].filter(Boolean)
  }).join(' ')
  return <svg viewBox={`-0.4 -0.4 ${cols + 0.8} ${rows + 0.8}`} aria-hidden="true">
    <rect x="-0.3" y="-0.3" width={cols + 0.6} height={rows + 0.6} rx="0.6" fill="var(--ws-preview-water)" />
    <path d={lines} fill="none" stroke="var(--ws-preview-wall)" strokeWidth="0.3" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
}

interface Props {
  initialProject?: MazeProject | null
  onProjectChange?(project: MazeProject): void
  onLibrary(): void
  onEdit(project: MazeProject): void
  onSave(project: MazeProject): Promise<void>
  onShare(project: MazeProject): void
}

export default function WaterStudio({ initialProject, onProjectChange, onLibrary, onEdit, onSave, onShare }: Props) {
  const [customProject, setCustomProject] = useState<MazeProject | null>(initialProject ?? null)
  const [preferences, setPreferences] = useState(readPreferences)
  const [draft, setDraft] = useState<WaterMazeOptions>(() => readPreferences().generator)
  const [paused, setPaused] = useState(false)
  const [inflow, setInflow] = useState(true)
  const [mode, setMode] = useState<'surface-3d' | 'free-surface'>('surface-3d')
  const [tab, setTab] = useState<'water' | 'material' | 'light' | 'maze'>('water')
  const [tuningOpen, setTuningOpen] = useState(false)
  const [focus, setFocus] = useState(false)
  const [retry, setRetry] = useState(0)
  const [status, setStatus] = useState<FreeSurfaceStatus | null>(null)
  const [renderState, setRenderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const mountRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<FreeSurfaceRuntime | null>(null)
  const latest = useRef({ preferences, mode })
  latest.current = { preferences, mode }
  const generatedProject = useMemo(() => preferences.source === 'generated'
    ? createGeneratedWaterMaze(preferences.generator)
    : createWaterStudioProject(preferences.preset, preferences.seed, preferences.size ? { rows: preferences.size, cols: preferences.size } : undefined),
    [preferences.source, preferences.generator, preferences.preset, preferences.seed, preferences.size])
  const project = customProject ?? generatedProject
  const sculpture = useMemo(() => preferences.source === 'flow'
    && (preferences.preset === 'atelier' || preferences.preset === 'cascade')
    && JSON.stringify(project.mazeGraph) === JSON.stringify(generatedProject.mazeGraph)
    ? 'terraced-fountain' as const : undefined,
  [preferences.source, preferences.preset, project.mazeGraph, generatedProject.mazeGraph])
  const onProjectChangeRef = useRef(onProjectChange)
  onProjectChangeRef.current = onProjectChange
  useEffect(() => { setCustomProject(initialProject ?? null) }, [initialProject])
  useEffect(() => { onProjectChangeRef.current?.(project) }, [project])
  const miniatureProjects = useMemo(() => WATER_STUDIO_PRESETS.map(preset => createWaterStudioProject(preset.id)), [])
  const selectedPreset = WATER_STUDIO_PRESETS.find(preset => preset.id === preferences.preset)!
  const selectedTheme = WATER_THEMES.find(theme => theme.id === preferences.look.theme)!
  const update = (value: Partial<StudioPreferences>) => setPreferences(previous => ({ ...previous, ...value }))
  const updateLook = (value: Partial<WaterLook>) => setPreferences(previous => ({ ...previous, look: { ...previous.look, ...value } }))
  const appearance = useMemo<WaterAppearance>(() => ({ color: preferences.color, profile: preferences.color === '#16aeb7' ? 'aqua' : preferences.color ? 'tinted' : 'clear', opacity: preferences.opacity }), [preferences.color, preferences.opacity])

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)) } catch { /* Storage may be disabled. */ }
  }, [preferences])
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let disposed = false
    let runtime: FreeSurfaceRuntime | null = null
    setRenderState('loading'); setStatus(null); setPaused(false); setInflow(true); setSaveState('idle')
    try {
      const current = latest.current
      runtime = new FreeSurfaceRuntime(mount, project, 'high', current.preferences.surface,
        () => { if (!disposed) setRenderState('ready') },
        next => { if (!disposed) setStatus(next) },
        message => { if (!disposed) { setError(message); setRenderState('error') } },
        () => undefined,
        false, sculpture,
      )
      runtime.setLook(current.preferences.look)
      runtime.setViewMode(current.mode)
      runtime.setAppearance({ color: current.preferences.color, profile: current.preferences.color === '#16aeb7' ? 'aqua' : current.preferences.color ? 'tinted' : 'clear', opacity: current.preferences.opacity })
      runtime.setInflowRate(current.preferences.flow)
      runtime.setSpeed(current.preferences.speed)
      runtimeRef.current = runtime
    } catch (reason) {
      runtime?.dispose()
      const canvas = mount.querySelector('canvas')
      try { canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* Context unavailable. */ }
      mount.replaceChildren()
      setError(reason instanceof Error ? reason.message : '물 시뮬레이션을 시작할 수 없습니다.')
      setRenderState('error')
    }
    return () => { disposed = true; runtime?.dispose(); if (runtimeRef.current === runtime) runtimeRef.current = null }
  }, [project, retry, sculpture])
  useEffect(() => { runtimeRef.current?.setLook(preferences.look) }, [preferences.look])
  useEffect(() => { runtimeRef.current?.setAppearance(appearance) }, [appearance])
  useEffect(() => { runtimeRef.current?.setInflowRate(preferences.flow) }, [preferences.flow])
  useEffect(() => { runtimeRef.current?.setSurfaceStyle(preferences.surface) }, [preferences.surface])
  useEffect(() => { runtimeRef.current?.setSpeed(preferences.speed) }, [preferences.speed])
  useEffect(() => { runtimeRef.current?.setViewMode(mode) }, [mode])
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setFocus(false); setTuningOpen(false) } }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])

  const togglePlayback = () => { runtimeRef.current?.setPaused(!paused); setPaused(!paused) }
  const toggleInflow = () => { runtimeRef.current?.setInflow(!inflow); setInflow(!inflow) }
  const restart = () => { runtimeRef.current?.restart(); setPaused(false); setInflow(true) }
  const save = async () => {
    setSaveState('saving')
    try { await onSave(project); setSaveState('saved') } catch { setSaveState('error') }
  }
  const isDesigned = customProject || preferences.source === 'generated'
  const openCreation = () => { setTab('maze'); setTuningOpen(true); setFocus(false) }
  const generate = () => { setTuningOpen(false); setCustomProject(null); update({ source: 'generated', generator: { ...draft, rows: Math.max(8, Math.min(32, Math.round(draft.rows || 12))), cols: Math.max(8, Math.min(32, Math.round(draft.cols || 12))) } }) }
  const sceneLabel = paused ? '일시정지' : !inflow ? '배수 중' : status?.saturated ? '유입 조절 중' : status?.reachedExit ? '흐르는 중' : '물을 붓는 중'
  const slider = (label: string, value: number, min: number, max: number, step: number, onChange: (n: number) => void, display: string) => <label className="ws-slider"><span>{label}<output>{display}</output></span><input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} /></label>

  return <main className={`water-studio${focus ? ' is-focused' : ''}${tuningOpen ? ' tuning-open' : ''}`} data-testid="water-studio" data-theme-name={preferences.look.theme}
    style={{ '--ws-scene': selectedTheme.background, '--ws-material': selectedTheme.color } as CSSProperties}>
    <header className="ws-header">
      <div className="ws-brand"><Waves size={25} strokeWidth={1.8} /><div><strong>MAZECRAFT</strong><span>WATER ATELIER</span></div></div>
      <nav className="ws-navigation" aria-label="주 메뉴"><span aria-current="page">물 스튜디오</span><button aria-label="내 미로" onClick={onLibrary}><FolderOpen size={16} /><span>내 미로</span></button></nav>
      <div className="ws-header-actions"><button className="ws-create-shortcut" aria-label="미로 만들기" onClick={openCreation}><Wand2 size={17} /><span>미로 만들기</span></button><button className="ws-icon" aria-label="몰입 화면" aria-pressed={focus} onClick={() => setFocus(!focus)}>{focus ? <X size={19} /> : <Expand size={19} />}</button><button className="ws-save" aria-label={saveState === 'saved' ? '미로 저장 완료' : '미로 저장'} disabled={saveState === 'saving'} onClick={() => void save()}>{saveState === 'saved' ? <Check size={16} /> : <Save size={16} />}<span>{saveState === 'saving' ? '저장 중' : saveState === 'saved' ? '저장 완료' : saveState === 'error' ? '다시 저장' : '미로 저장'}</span></button></div>
    </header>
    <div className="ws-workspace">
      <section className="ws-view" aria-label="물 미로 작업 공간">
        <div className="ws-scene-heading"><span className="ws-eyebrow">WATER ATELIER / {project.mazeGraph.cols} × {project.mazeGraph.rows}</span><h1>{isDesigned ? project.title : selectedPreset.name}</h1><p>{isDesigned ? '나의 모양, 나의 물길' : selectedPreset.caption}</p></div>
        <div className="ws-status"><i className={paused ? 'is-paused' : ''} />{renderState === 'ready' ? sceneLabel : renderState === 'error' ? '실행 오류' : '준비 중'}</div>
        <div className="ws-canvas" ref={mountRef} data-testid="water-studio-canvas" data-renderer={renderState} data-view-mode={mode} data-particle-count={status?.particleCount ?? 0} data-simulation-time={status?.simulationTime ?? 0} />
        {renderState === 'loading' && <div className="ws-stage-message" role="status"><Waves size={30} /><span>수로를 준비하고 있습니다</span></div>}
        {renderState === 'error' && <div className="ws-stage-message" role="alert"><strong>화면을 시작하지 못했습니다</strong><p>{error}</p><button onClick={() => setRetry(n => n + 1)}>다시 시작</button></div>}
        <div className="ws-view-controls"><div className="ws-segment" aria-label="보기 방식"><button aria-pressed={mode === 'surface-3d'} onClick={() => setMode('surface-3d')}>3D</button><button aria-pressed={mode === 'free-surface'} onClick={() => setMode('free-surface')}>2D</button></div><button className="ws-icon" aria-label="축소" onClick={() => runtimeRef.current?.zoomCamera(1 / 1.2)}><Minus size={17} /></button><button className="ws-icon" aria-label="확대" onClick={() => runtimeRef.current?.zoomCamera(1.2)}><Plus size={17} /></button><button className="ws-icon" aria-label="시점 초기화" onClick={() => runtimeRef.current?.resetCamera()}><Maximize2 size={17} /></button></div>
        <div className="ws-transport">
          <button className="ws-play" aria-label={paused ? '재생' : '일시정지'} disabled={renderState !== 'ready'} onClick={togglePlayback}>{paused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}</button>
          <button className="ws-icon" aria-label="물 다시 붓기" disabled={renderState !== 'ready'} onClick={restart}><RotateCcw size={19} /></button>
          <label className="ws-speed"><span className="sr-only">재생 속도</span><select aria-label="재생 속도" value={preferences.speed} onChange={event => update({ speed: Number(event.target.value) })}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select><ChevronDown size={13} /></label>
          <span className="ws-transport-divider" />
          <button className="ws-pour" aria-label={inflow ? '물 붓기 켜짐' : '물 붓기 꺼짐'} aria-pressed={inflow} onClick={toggleInflow}><Droplets size={18} /><span>{inflow ? '물 붓기 켜짐' : '물 붓기 꺼짐'}</span></button>
          <button className="ws-mobile-tune ws-icon" aria-label="튜닝 열기" aria-expanded={tuningOpen} aria-controls="water-tuning" onClick={() => setTuningOpen(!tuningOpen)}><SlidersHorizontal size={18} /></button>
        </div>
        <span className="ws-camera-hint">드래그하여 회전 · 두 손가락으로 확대</span>
        {focus && <button className="ws-focus-exit" onClick={() => setFocus(false)}><X size={16} />몰입 화면 닫기</button>}
      </section>
      <aside className="ws-tuning" id="water-tuning" aria-label="시뮬레이션 튜닝">
        <div className="ws-panel-heading"><div><span className="ws-eyebrow">DESIGN YOUR FLOW</span><h2>{tab === 'maze' ? '미로 만들기' : '물과 재질'}</h2></div><SlidersHorizontal size={20} /><button className="ws-mobile-tune ws-icon" aria-label="튜닝 닫기" onClick={() => setTuningOpen(false)}><X size={19} /></button></div>
        <div className="ws-tabs" role="tablist" aria-label="튜닝 항목">{([['maze', '미로'], ['water', '물'], ['material', '재질'], ['light', '빛']] as const).map(([id, label]) => <button key={id} role="tab" id={`ws-tab-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onKeyDown={event => {
          const tabs = ['maze', 'water', 'material', 'light'] as const
          const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
          if (!offset && event.key !== 'Home' && event.key !== 'End') return
          event.preventDefault()
          const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (tabs.indexOf(tab) + offset + 4) % 4]
          setTab(next); document.getElementById(`ws-tab-${next}`)?.focus()
        }} aria-controls={`ws-panel-${id}`} onClick={() => setTab(id)}>{label}</button>)}</div>
        <div className="ws-panel-content" role="tabpanel" id={`ws-panel-${tab}`} aria-labelledby={`ws-tab-${tab}`}>
          {tab === 'water' && <>
            <div className="ws-section-label"><span>물의 색</span><span>WATER COLOR</span></div>
            <div className="ws-water-colors" role="group" aria-label="물 색상">{WATER_COLOR_PRESETS.map(item => <button key={item.id} title={item.label} aria-label={`물 색상 ${item.label}`} aria-pressed={preferences.color === item.color} style={{ '--swatch': item.color ?? '#f5e4d8' } as CSSProperties} onClick={() => update({ color: item.color })}><i />{preferences.color === item.color && <Check size={13} />}</button>)}</div>
            <label className="ws-custom-color">직접 선택<input type="color" aria-label="물 색상 직접 선택" value={preferences.color ?? '#72d1df'} onChange={event => update({ color: event.target.value })} /></label>
            {slider('유입량', preferences.flow, 0.1, 2.5, 0.05, flow => update({ flow }), `${preferences.flow.toFixed(2)}×`)}
            {slider('물의 농도', preferences.opacity, 0.2, 0.9, 0.01, opacity => update({ opacity }), `${Math.round(preferences.opacity * 100)}%`)}
            <div className="ws-section-label"><span>수면의 움직임</span></div><div className="ws-option-row">{([['calm', '잔잔하게'], ['natural', '자연스럽게'], ['dynamic', '생동감 있게']] as const).map(([id, label]) => <button key={id} aria-pressed={preferences.surface === id} onClick={() => update({ surface: id })}>{label}</button>)}</div>
          </>}
          {tab === 'material' && <><div className="ws-section-label"><span>미로의 재질</span><span>MATERIAL</span></div><div className="ws-material-grid">{WATER_THEMES.map(theme => <button key={theme.id} aria-pressed={preferences.look.theme === theme.id} onClick={() => updateLook({ theme: theme.id })}><i style={{ '--material-color': theme.color } as CSSProperties} data-material={theme.id} /><span>{theme.label}</span>{preferences.look.theme === theme.id && <Check size={13} />}</button>)}</div>{slider('벽 높이', preferences.look.wallHeight, 0.55, 1.75, 0.05, wallHeight => updateLook({ wallHeight }), `${preferences.look.wallHeight.toFixed(2)}×`)}</>}
          {tab === 'light' && <><div className="ws-section-label"><span>빛의 분위기</span><span>LIGHTING</span></div><div className="ws-light-options">{([['daylight', '맑은 낮', '부드럽고 선명한 빛'], ['golden', '오후의 햇살', '따뜻한 색감과 음영'], ['studio', '스튜디오', '재질을 드러내는 차분한 빛']] as const).map(([id, label, caption]) => <button key={id} data-light={id} aria-pressed={preferences.look.light === id} onClick={() => updateLook({ light: id })}><i /><span><strong>{label}</strong><small>{caption}</small></span>{preferences.look.light === id && <Check size={15} />}</button>)}</div></>}
          {tab === 'maze' && <>
            <div className="ws-section-label"><span>미로의 모양</span></div>
            <div className="ws-shape-grid">{WATER_MAZE_SHAPES.map(([id, name], index) => {
              const Icon = [Square, Circle, Hexagon, Heart, Star, Diamond][index]
              return <button key={id} aria-pressed={draft.shape === id} onClick={() => setDraft(p => ({ ...p, shape: id }))}><Icon size={23} strokeWidth={1.5} /><span>{name}</span></button>
            })}</div>
            <div className="ws-dimensions"><label>가로 셀<input type="number" min={8} max={32} value={draft.cols} onChange={e => setDraft(p => ({ ...p, cols: Number(e.target.value) }))} /></label><span>×</span><label>세로 셀<input type="number" min={8} max={32} value={draft.rows} onChange={e => setDraft(p => ({ ...p, rows: Number(e.target.value) }))} /></label></div>
            <div className="ws-quick-sizes">{[8, 12, 16, 24].map(size => <button key={size} aria-pressed={draft.cols === size && draft.rows === size} onClick={() => setDraft(p => ({ ...p, rows: size, cols: size }))}>{size} × {size}</button>)}</div>
            <div className="ws-section-label"><span>물길의 구조</span></div><div className="ws-algorithms">{([['dfs', 'DFS', '긴 통로'], ['prim', 'Prim', '많은 갈림길'], ['kruskal', 'Kruskal', '고른 분기']] as const).map(([id, name, detail]) => <button key={id} aria-pressed={draft.algorithm === id} onClick={() => setDraft(p => ({ ...p, algorithm: id }))}><strong>{name}</strong><small>{detail}</small></button>)}</div>
            <label className="ws-generator-field">복잡도<select value={draft.difficulty} onChange={e => setDraft(p => ({ ...p, difficulty: e.target.value as WaterMazeOptions['difficulty'] }))}><option value="easy">가볍게</option><option value="normal">균형 있게</option><option value="hard">복잡하게</option><option value="expert">아주 복잡하게</option></select></label>
            <label className="ws-generator-field">시드<span className="ws-seed-input"><input value={draft.seed} maxLength={120} onChange={e => setDraft(p => ({ ...p, seed: e.target.value }))} /><button aria-label="새 시드" onClick={() => setDraft(p => ({ ...p, seed: crypto.randomUUID().slice(0, 8) }))}><Shuffle size={17} /></button></span></label>

          </>}

        </div>
        {tab === 'maze' && <div className="ws-generator-cta"><button className="ws-generate" onClick={generate}><Wand2 size={18} />이 설정으로 미로 생성</button><button className="ws-editor-link" onClick={() => onEdit(project)}><Pencil size={15} /><span>전체 제작기 · 글자 / 이미지 / 벽 편집</span><ArrowUpRight size={15} /></button></div>}
        <div className="ws-panel-footer"><span>{selectedTheme.label}</span><button onClick={() => { update({ look: DEFAULT_WATER_LOOK, color: defaults.color, opacity: defaults.opacity, flow: defaults.flow, surface: defaults.surface, speed: defaults.speed }) }}>튜닝 초기화</button></div>
      </aside>
    </div>
    <footer className="ws-collection"><div className="ws-collection-title"><span className="ws-eyebrow">FLOW COLLECTION</span><strong>수로 컬렉션</strong></div><div className="ws-presets" role="group" aria-label="미로 프리셋">{WATER_STUDIO_PRESETS.map((preset, index) => <button key={preset.id} className="ws-preset" aria-pressed={!customProject && preferences.source === 'flow' && preferences.preset === preset.id} onClick={() => { setCustomProject(null); update({ source: 'flow', preset: preset.id, size: 0 }) }}><span className="ws-miniature"><MazeMiniature project={miniatureProjects[index]} /></span><span><small>0{index + 1}</small><strong>{preset.name}</strong></span>{!customProject && preferences.source === 'flow' && preferences.preset === preset.id && <i />}</button>)}</div><button className="ws-share" onClick={() => onShare(project)} aria-label="현재 미로 공유"><ArrowUpRight size={21} /><span>공유</span></button></footer>
  </main>
}
