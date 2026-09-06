import {
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Scan,
  Waves,
  Droplets,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Modal } from '../../components/Modal'
import type { MazeProject } from '../../core/maze'
import type {
  ResolvedWaterQuality,
  WaterRuntimeMetrics,
} from './waterSceneRuntime'
import type { WaterSurfaceStyle } from './rendering'
import { FreeSurfaceRuntime, type FreeSurfaceStatus } from './freeSurface/runtime'
import {
  COLORED_WATER_OPACITY,
  DEFAULT_WATER_APPEARANCE,
  WATER_COLOR_PRESETS,
  type WaterAppearance,
  type WaterColorPresetId,
} from './freeSurface/appearance'

export type WaterEffectQuality = 'auto' | 'low' | 'high'

interface WaterSimulationDialogProps {
  open: boolean
  project: MazeProject
  quality: WaterEffectQuality
  onClose: () => void
}

const EMPTY_STATUS: FreeSurfaceStatus = {
  elapsedMs: 0,
  simulationTime: 0,
  filledCells: 0,
  totalCells: 0,
  reachedExit: false,
  complete: false,
  inletState: 'off',
  inletVisible: false,
  outletVisible: false,
  activeFlowEdgeCount: 0,
  cumulativeInjectedVolume: 0,
  cumulativeOutletVolume: 0,
  currentStoredVolume: 0,
  absoluteMassError: 0,
  relativeMassError: 0,
  maxVelocity: 0,
  outletDischarge: 0,
  particleCount: 0,
  escapedVolume: 0,
  saturated: false,
}

const EMPTY_METRICS: WaterRuntimeMetrics = {
  atlasWidth: 0,
  atlasHeight: 0,
  closedWallLeakTexels: 0,
  drawCalls: 0,
  triangles: 0,
  inletDropHeight: 0,
  inletContactGap: 0,
  outletDropHeight: 0,
  physicsStepHz: 120,
  snapshotHz: 25,
  solverMode: 'main-thread',
  waveBands: 2,
  foamMode: 'procedural',
}

const resolveQuality = (
  quality: WaterEffectQuality,
  activeCellCount: number,
): ResolvedWaterQuality => {
  if (quality !== 'auto') return quality
  if (typeof navigator === 'undefined') return 'low'
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const constrainedDevice =
    navigator.hardwareConcurrency <= 4 ||
    (memory !== undefined && memory <= 4)
  return constrainedDevice || activeCellCount > 3_600 ? 'low' : 'high'
}

export default function WaterSimulationDialog({
  open,
  project,
  quality,
  onClose,
}: WaterSimulationDialogProps) {
  const canvasMountRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<FreeSurfaceRuntime | null>(null)
  const [mode, setMode] = useState<'free-surface' | 'surface-3d'>('free-surface')
  const viewModeRef = useRef(mode)
  const [inflow, setInflow] = useState(true)
  const [status, setStatus] = useState<FreeSurfaceStatus>(EMPTY_STATUS)
  const [metrics, setMetrics] = useState<WaterRuntimeMetrics>(EMPTY_METRICS)
  const [paused, setPaused] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [surfaceStyle, setSurfaceStyle] =
    useState<WaterSurfaceStyle>('natural')
  const surfaceStyleRef = useRef(surfaceStyle)
  const [colorPreset, setColorPreset] = useState<WaterColorPresetId>('clear')
  const [customColor, setCustomColor] = useState('#db668f')
  const appearance = useMemo<WaterAppearance>(() => {
    const color = colorPreset === 'custom'
      ? customColor
      : WATER_COLOR_PRESETS.find((preset) => preset.id === colorPreset)?.color ?? null
    return color === null
      ? DEFAULT_WATER_APPEARANCE
      : { color, opacity: COLORED_WATER_OPACITY }
  }, [colorPreset, customColor])
  const appearanceRef = useRef(appearance)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [renderState, setRenderState] = useState<
    'initializing' | 'ready' | 'error'
  >('initializing')
  const [errorMessage, setErrorMessage] = useState('')
  const activeCellCount = useMemo(
    () => project.mazeGraph.cells.filter((cell) => cell.active).length,
    [project.mazeGraph],
  )
  const resolvedQuality = useMemo(
    () => resolveQuality(quality, activeCellCount),
    [activeCellCount, quality],
  )
  const reducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )
  useEffect(() => {
    if (!open || !canvasMountRef.current) return
    const mount = canvasMountRef.current
    let disposed = false
    let runtime: FreeSurfaceRuntime | null = null
    setStatus({ ...EMPTY_STATUS, totalCells: activeCellCount })
    setMetrics(EMPTY_METRICS)
    setPaused(false)
    setInflow(true)
    setRenderState('initializing')
    setErrorMessage('')
    try {
      runtime = new FreeSurfaceRuntime(
        mount,
        project,
        resolvedQuality,
        surfaceStyleRef.current,
        () => {
          if (!disposed) setRenderState('ready')
        },
        (nextStatus) => {
          if (!disposed) setStatus(nextStatus)
        },
        (message) => {
          if (disposed) return
          setRenderState('error')
          setErrorMessage(message)
        },
        (nextMetrics) => {
          if (!disposed) setMetrics(nextMetrics)
        },
        reducedMotion,
      )
      runtime.setViewMode(viewModeRef.current)
      runtime.setAppearance(appearanceRef.current)
      runtime.setSpeed(speed)
      runtimeRef.current = runtime
    } catch (error) {
      // If Three.js throws part-way through construction, its runtime instance
      // is not available to dispose. Explicitly lose the orphaned context so a
      // repeated open does not consume the browser's WebGL context budget.
      const failedCanvas = mount.querySelector('canvas')
      try {
        const context =
          failedCanvas?.getContext('webgl2') ??
          failedCanvas?.getContext('webgl')
        context?.getExtension('WEBGL_lose_context')?.loseContext()
      } catch {
        // Context creation itself can be the failing operation.
      }
      mount.replaceChildren()
      setRenderState('error')
      setErrorMessage(
        error instanceof Error
          ? error.message
          : '이 브라우저에서 물 시뮬레이션을 시작할 수 없습니다.',
      )
    }
    return () => {
      disposed = true
      runtime?.dispose()
      if (runtimeRef.current === runtime) runtimeRef.current = null
    }
  }, [
    activeCellCount,
    open,
    project,
    reducedMotion,
    resolvedQuality,
  ])

  useEffect(() => {
    viewModeRef.current = mode
    if (open) runtimeRef.current?.setViewMode(mode)
  }, [mode, open])

  useEffect(() => {
    runtimeRef.current?.setSpeed(speed)
  }, [speed])

  useEffect(() => {
    surfaceStyleRef.current = surfaceStyle
    if (open) runtimeRef.current?.setSurfaceStyle(surfaceStyle)
  }, [open, surfaceStyle])

  useEffect(() => {
    appearanceRef.current = appearance
    if (open) runtimeRef.current?.setAppearance(appearance)
  }, [appearance, open])

  const restart = useCallback(() => {
    runtimeRef.current?.restart()
    setPaused(false)
    setInflow(true)
  }, [])

  const togglePlayback = () => {
    const next = !paused
    runtimeRef.current?.setPaused(next)
    setPaused(next)
  }

  const wetFraction = status.totalCells > 0
    ? status.filledCells / status.totalCells
    : 0
  const isFreeSurface = mode === 'free-surface'
  const phaseProgress = Math.min(100, Math.max(0, wetFraction * 100))
  const toggleInflow = () => {
    const next = !inflow
    runtimeRef.current?.setInflow(next)
    setInflow(next)
  }
  const phase = renderState === 'error'
    ? 'error'
    : paused
      ? 'paused'
      : status.complete
        ? 'steady-flow'
        : status.reachedExit
          ? 'reached-exit'
          : 'pouring'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="물 미로"
      description="물을 붓고, 갈라지고 고이는 흐름을 관찰하세요."
      width="min(1180px, calc(100vw - 24px))"
      className="water-simulation-modal"
      closeLabel="물 시뮬레이션 닫기"
    >
      <div className="water-simulation-shell">
        <div
          className="water-simulation-stage"
          data-testid="water-simulation-stage"
          data-renderer={renderState}
          data-fluid-renderer="particle-density-free-boundary"
          data-fluid-model="position-based-free-surface"
          data-view-mode={mode}
          data-particle-count={status.particleCount}
          data-escaped-volume={status.escapedVolume}
          data-inflow={inflow ? 'enabled' : 'disabled'}
          data-saturated={status.saturated}
          data-flow-mode="continuous-until-user-pauses"
          data-water-continuity="coupled-source-surface"
          data-phase={phase}
          data-quality={resolvedQuality}
          data-start-edge="top"
          data-end-edge="bottom"
          data-active-cells={activeCellCount}
          data-wettable-cells={activeCellCount}
          data-filled-cells={status.filledCells}
          data-reached-exit={status.reachedExit}
          data-through-flow={status.complete}
          data-settled={status.complete}
          data-solver-mode={
            metrics.solverMode === 'worker'
              ? 'worker'
              : 'main-thread-fallback'
          }
          data-physics-step-hz={metrics.physicsStepHz}
          data-snapshot-hz={metrics.snapshotHz}
          data-active-flow-edges={status.activeFlowEdgeCount}
          data-injected-volume={status.cumulativeInjectedVolume}
          data-outlet-volume={status.cumulativeOutletVolume}
          data-stored-volume={status.currentStoredVolume}
          data-mass-absolute-error={status.absoluteMassError}
          data-mass-relative-error={status.relativeMassError}
          data-max-velocity={status.maxVelocity}
          data-outlet-discharge={status.outletDischarge}
          data-atlas-width={metrics.atlasWidth}
          data-atlas-height={metrics.atlasHeight}
          data-closed-wall-leak-texels={metrics.closedWallLeakTexels}
          data-draw-calls={metrics.drawCalls}
          data-triangles={metrics.triangles}
          data-inlet-renderer="simulated-particle-inlet"
          data-inlet-state={status.inletState}
          data-inlet-visible={status.inletVisible}
          data-inlet-drop-height={metrics.inletDropHeight.toFixed(2)}
          data-inlet-contact-gap={metrics.inletContactGap.toFixed(3)}
          data-outlet-renderer="simulated-particle-free-fall"
          data-outlet-visible={status.outletVisible}
          data-outlet-drop-height={metrics.outletDropHeight.toFixed(2)}
          data-water-surface-renderer="continuous-density-contour"
          data-water-surface-style={surfaceStyle}
          data-water-color={appearance.color ?? 'clear'}
          data-water-color-preset={colorPreset}
          data-water-opacity={appearance.opacity}
          data-wave-bands={metrics.waveBands}
          data-water-reflection="continuous-surface-lighting"
          data-foam-mode={metrics.foamMode}
          data-elapsed-ms={Math.round(status.simulationTime * 1_000)}
          data-scene-elapsed-ms={Math.round(status.elapsedMs)}
          role={renderState === 'error' ? undefined : 'img'}
          aria-label={
            renderState === 'error'
              ? undefined
              : `${project.title}의 물리 기반 물 미로 실험. 물이 열린 아래쪽과 옆 통로를 따라 바닥부터 차오른 뒤 하단 출구 밖으로 떨어집니다.`
          }
        >
          <div
            ref={canvasMountRef}
            className="water-simulation-canvas-host"
            aria-hidden="true"
          />
          <div className="water-film-grain" aria-hidden="true" />
          <div className="water-shot-label" aria-hidden="true">
            <span>TOP FEED</span>
            <i />
            <span>BOTTOM EXIT</span>
          </div>
          {renderState === 'initializing' && (
            <div className="water-stage-message">
              <Waves size={28} />
              <strong>유체 장면을 만드는 중…</strong>
            </div>
          )}
          {renderState === 'error' && (
            <div className="water-stage-message error" role="alert">
              <strong>물 시뮬레이션을 열지 못했습니다.</strong>
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        <div
          className="water-simulation-progress"
          data-phase={phase}
          aria-hidden="true"
        >
          <span style={{ width: `${phaseProgress}%` }} />
        </div>

        <div className="water-simulation-status">
          <div className="water-simulation-controls">
            <label className="water-speed-control water-mode-control">
              <select aria-label="물 시뮬레이션 방식" value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}>
                <option value="free-surface">물 흐름</option>
                <option value="surface-3d">3D 수면</option>
              </select>
            </label>
            <button
              className="button secondary"
              onClick={togglePlayback}
              disabled={renderState !== 'ready'}
              aria-label={
                paused
                  ? '물 시뮬레이션 재생'
                  : '물 시뮬레이션 일시정지'
              }
            >
              {paused ? (
                <Play size={17} />
              ) : (
                <Pause size={17} />
              )}
              {paused ? '계속' : '일시정지'}
            </button>
            <button
              className="button secondary"
              onClick={restart}
              aria-label="물 시뮬레이션 처음부터"
              disabled={renderState !== 'ready'}
            >
              <RotateCcw size={17} />
              처음부터
            </button>
            <button className="button secondary water-inflow-control" onClick={toggleInflow}
              disabled={renderState !== 'ready'} aria-pressed={inflow}
              aria-label={inflow ? '물 공급 멈추기' : '물 공급 시작하기'}>
              <Droplets size={17} />{inflow ? '공급 끄기' : '물 붓기'}
            </button>
            <button
              className="button secondary"
              onClick={() => runtimeRef.current?.resetCamera()}
              disabled={renderState !== 'ready'}
            >
              <Scan size={17} />
              화면 맞춤
            </button>
            <label className="water-speed-control">
              <Gauge size={16} aria-hidden="true" />
              <span>속도</span>
              <select
                aria-label="물 흐름 속도"
                value={speed}
                disabled={renderState !== 'ready'}
                onChange={(event) => setSpeed(Number(event.target.value))}
              >
                <option value={0.1}>0.1×</option>
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={4}>4×</option>
              </select>
            </label>
            {import.meta.env.DEV && (
              <button
                className="button secondary water-diagnostics-toggle"
                type="button"
                aria-expanded={showDiagnostics}
                onClick={() => setShowDiagnostics((visible) => !visible)}
              >
                <Gauge size={17} />
                물리 진단
              </button>
            )}
          </div>
          <div className="water-appearance-controls">
            <div className="water-palette" role="group" aria-label="물 색상">
              <span className="water-control-caption">물 색상</span>
              <div className="water-color-options">
                {WATER_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="water-color-option"
                    aria-label={`물 색상 ${preset.label}`}
                    aria-pressed={colorPreset === preset.id}
                    onClick={() => setColorPreset(preset.id)}
                  >
                    <span
                      className={`water-color-preview${preset.color === null ? ' is-clear' : ''}`}
                      style={{ '--water-swatch': preset.color ?? '#d4ecee' } as CSSProperties}
                      aria-hidden="true"
                    />
                    <span>{preset.label}</span>
                  </button>
                ))}
                <label className="water-color-option water-custom-color" data-selected={colorPreset === 'custom'}>
                  <span className="water-color-preview" style={{ '--water-swatch': customColor } as CSSProperties} aria-hidden="true" />
                  <span>직접 선택</span>
                  <input
                    type="color"
                    value={customColor}
                    aria-label="물 색상 직접 선택"
                    onClick={() => setColorPreset('custom')}
                    onChange={(event) => {
                      setCustomColor(event.target.value)
                      setColorPreset('custom')
                    }}
                  />
                </label>
              </div>
            </div>
            <div className="water-surface-options" role="group" aria-label="수면 표현">
              <span className="water-control-caption">수면 표현</span>
              <div className="water-style-buttons">
                {([
                  ['calm', '잔잔함'],
                  ['natural', '자연'],
                  ['dynamic', '역동'],
                ] as const).map(([style, label]) => (
                  <button
                    key={style}
                    type="button"
                    aria-pressed={surfaceStyle === style}
                    onClick={() => setSurfaceStyle(style)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {import.meta.env.DEV && showDiagnostics && (
          <dl className="water-physics-diagnostics">
            <div>
              <dt>솔버</dt>
              <dd>
                {metrics.solverMode} · {metrics.physicsStepHz} Hz
              </dd>
            </div>
            <div>
              <dt>시뮬레이션</dt>
              <dd>{status.simulationTime.toFixed(3)} s</dd>
            </div>
            <div>
              <dt>물의 단면적</dt>
              <dd>
                유입 {status.cumulativeInjectedVolume.toExponential(3)} / 저장{' '}
                {status.currentStoredVolume.toExponential(3)} / 유출{' '}
                {status.cumulativeOutletVolume.toExponential(3)} 셀²
              </dd>
            </div>
            <div>
              <dt>질량 오차</dt>
              <dd>
                {status.absoluteMassError.toExponential(3)} 셀² ·{' '}
                {(status.relativeMassError * 100).toFixed(4)}%
              </dd>
            </div>
            <div>
              <dt>유체 입자</dt>
              <dd>
                {status.particleCount} · 최고{' '}
                {status.maxVelocity.toFixed(3)} 셀/s
              </dd>
            </div>
          </dl>
        )}

        <div className="water-simulation-legend">
          <span>{isFreeSurface ? '드래그: 이동' : '드래그: 미세 시점 조절'}</span>
          <span>두 손가락: 확대</span>
          <span>
            {resolvedQuality === 'high' ? '고화질' : '모바일 최적화'}
          </span>
        </div>
      </div>
    </Modal>
  )
}
