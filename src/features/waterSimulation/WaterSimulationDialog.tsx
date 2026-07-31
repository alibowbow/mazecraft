import {
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Scan,
  Waves,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Modal } from '../../components/Modal'
import type { MazeProject } from '../../core/maze'
import {
  WaterSceneRuntime,
  type ResolvedWaterQuality,
  type WaterPlaybackStatus,
  type WaterRuntimeMetrics,
} from './waterSceneRuntime'
import { buildWaterSimulation } from './waterModel'
import { fitWaterSimulationToBudget } from './waterPlaybackTiming'

export type WaterEffectQuality = 'auto' | 'low' | 'high'

interface WaterSimulationDialogProps {
  open: boolean
  project: MazeProject
  quality: WaterEffectQuality
  onClose: () => void
}

const EMPTY_STATUS: WaterPlaybackStatus = {
  elapsedMs: 0,
  filledCells: 0,
  totalCells: 0,
  reachedExit: false,
  complete: false,
}

const EMPTY_METRICS: WaterRuntimeMetrics = {
  atlasWidth: 0,
  atlasHeight: 0,
  drawCalls: 0,
  triangles: 0,
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

const resolvePlaybackBudget = (activeCellCount: number) => {
  const maxExitMs = Math.min(
    13_500,
    Math.max(9_000, 7_800 + Math.log2(activeCellCount + 1) * 650),
  )
  return {
    maxExitMs,
    maxFlowMs: maxExitMs + 3_500,
  }
}

export default function WaterSimulationDialog({
  open,
  project,
  quality,
  onClose,
}: WaterSimulationDialogProps) {
  const canvasMountRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<WaterSceneRuntime | null>(null)
  const [status, setStatus] = useState<WaterPlaybackStatus>(EMPTY_STATUS)
  const [metrics, setMetrics] = useState<WaterRuntimeMetrics>(EMPTY_METRICS)
  const [paused, setPaused] = useState(false)
  const [speed, setSpeed] = useState(1)
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
  const model = useMemo(
    () => {
      const baseModel = buildWaterSimulation(
        project.mazeGraph,
        project.startCell,
        project.endCell,
        {
          downwardTravelMs: 125,
          horizontalTravelMs: 235,
          upwardTravelMs: 680,
          cellFillMs: 105,
          branchSlowdown: 0.62,
          drainDelayMs: 620,
          drainDurationMs: 1_500,
          residualFilmLevel: 0.09,
          pooledLevel: 0.86,
        },
      )
      return fitWaterSimulationToBudget(
        baseModel,
        resolvePlaybackBudget(activeCellCount),
      )
    },
    [
      activeCellCount,
      project.mazeGraph,
      project.startCell,
      project.endCell,
    ],
  )
  const reachableCellCount = useMemo(
    () => model.cells.filter((cell) => cell.reachable).length,
    [model],
  )

  useEffect(() => {
    if (!open || !canvasMountRef.current) return
    const mount = canvasMountRef.current
    setStatus({ ...EMPTY_STATUS, totalCells: reachableCellCount })
    setMetrics(EMPTY_METRICS)
    setPaused(false)
    setRenderState('initializing')
    setErrorMessage('')
    try {
      const runtime = new WaterSceneRuntime(
        mount,
        project,
        model,
        resolvedQuality,
        (next) => {
          setStatus(next)
          if (next.complete) setPaused(true)
        },
        (message) => {
          setRenderState('error')
          setErrorMessage(message)
        },
        setMetrics,
        reducedMotion,
      )
      runtime.setSpeed(speed)
      runtimeRef.current = runtime
      setRenderState('ready')
    } catch (error) {
      setRenderState('error')
      setErrorMessage(
        error instanceof Error
          ? error.message
          : '이 브라우저에서 3D 화면을 시작할 수 없습니다.',
      )
    }
    return () => {
      runtimeRef.current?.dispose()
      runtimeRef.current = null
    }
  }, [
    model,
    open,
    project,
    reachableCellCount,
    reducedMotion,
    resolvedQuality,
  ])

  useEffect(() => {
    runtimeRef.current?.setSpeed(speed)
  }, [speed])

  const restart = useCallback(() => {
    runtimeRef.current?.restart()
    setPaused(false)
  }, [])

  const togglePlayback = () => {
    if (status.complete) {
      restart()
      return
    }
    setPaused((value) => {
      const next = !value
      runtimeRef.current?.setPaused(next)
      return next
    })
  }

  const progress =
    status.totalCells > 0
      ? Math.round((status.filledCells / status.totalCells) * 100)
      : 0
  const statusLabel = status.complete
    ? '유체 실험 완료'
    : paused
        ? '일시정지'
        : status.reachedExit
          ? '출구를 뚫고 배출되는 중'
        : status.filledCells > 1
          ? '갈림길마다 유량을 나누는 중'
          : '상단 저장조에서 물을 붓는 중'
  const phase = renderState === 'error'
    ? 'error'
    : status.complete
      ? 'complete'
      : paused
          ? 'paused'
          : status.reachedExit
            ? 'reached-exit'
          : 'pouring'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="시네마틱 물 미로"
      description="밝은 아크릴 실험 장치 안에서 물이 위에서 아래로 흐릅니다. 연결된 수면, 갈림길 유량, 막다른 길 고임과 출구 분출을 연속적으로 표현합니다."
      width="min(1180px, calc(100vw - 24px))"
      className="water-simulation-modal"
      closeLabel="3D 물 시뮬레이션 닫기"
    >
      <div className="water-simulation-shell">
        <div
          className="water-simulation-stage"
          data-testid="water-simulation-stage"
          data-renderer={renderState}
          data-fluid-renderer="timeline-surface"
          data-phase={phase}
          data-quality={resolvedQuality}
          data-start-edge="top"
          data-end-edge="bottom"
          data-filled-cells={status.filledCells}
          data-reached-exit={status.reachedExit}
          data-atlas-width={metrics.atlasWidth}
          data-atlas-height={metrics.atlasHeight}
          data-draw-calls={metrics.drawCalls}
          data-triangles={metrics.triangles}
          role="img"
          aria-label={`${project.title}의 물 미로 실험. 청록색 물이 상단 저장조에서 연속된 통로를 따라 최하단 출구로 흐릅니다.`}
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
          {status.reachedExit && renderState === 'ready' && (
            <div className="water-success-cue" aria-hidden="true">
              <span />
              출구 도달
            </div>
          )}
          {renderState === 'initializing' && (
            <div className="water-stage-message">
              <Waves size={28} />
              <strong>유체 장면을 만드는 중…</strong>
            </div>
          )}
          {renderState === 'error' && (
            <div className="water-stage-message error" role="alert">
              <strong>3D 화면을 열지 못했습니다.</strong>
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        <div className="water-simulation-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>

        <div className="water-simulation-status">
          <div className="water-status-copy" aria-live="polite">
            <span className={status.reachedExit ? 'reached' : ''}>
              <Waves size={16} />
              {statusLabel}
            </span>
            <small>
              {status.filledCells.toLocaleString()} /{' '}
              {status.totalCells.toLocaleString()} 셀 · {progress}%
            </small>
          </div>
          <div className="water-simulation-controls">
            <button
              className="button secondary"
              onClick={togglePlayback}
              disabled={renderState !== 'ready'}
              aria-label={
                status.complete
                  ? '물을 처음부터 다시 붓기'
                  : paused
                    ? '물 시뮬레이션 재생'
                    : '물 시뮬레이션 일시정지'
              }
            >
              {status.complete ? (
                <RotateCcw size={17} />
              ) : paused ? (
                <Play size={17} />
              ) : (
                <Pause size={17} />
              )}
              {status.complete ? '다시 붓기' : paused ? '계속' : '일시정지'}
            </button>
            <button
              className="button secondary"
              onClick={restart}
              disabled={renderState !== 'ready'}
            >
              <RotateCcw size={17} />
              처음부터
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
                onChange={(event) => setSpeed(Number(event.target.value))}
              >
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={4}>4×</option>
              </select>
            </label>
          </div>
        </div>

        <div className="water-simulation-legend">
          <span>드래그: 미세 시점 조절</span>
          <span>두 손가락: 확대</span>
          <span>
            {resolvedQuality === 'high' ? '시네마틱 고화질' : '모바일 최적화'}
          </span>
        </div>
      </div>
    </Modal>
  )
}
