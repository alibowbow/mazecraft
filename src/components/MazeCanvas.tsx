import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  MazeCanvasRenderer,
  type MazeCanvasRendererOptions,
} from '../renderer/canvasRenderer'
import type {
  MazeDirection,
  MazeHit,
  MazeRenderFrame,
  MazeRenderModel,
  MazeRenderTheme,
  MazeScreenPoint,
  MazeViewport,
} from '../renderer/types'
import { DEFAULT_MAZE_RENDER_THEME } from '../renderer/types'

export type MazeCanvasMode = 'view' | 'edit' | 'play'

export interface MazeEditGesture {
  phase: 'start' | 'move' | 'end' | 'cancel'
  hit: MazeHit | null
  pointerId: number
  gestureId: number
  originalEvent: PointerEvent
}

export interface MazeCanvasProps {
  model: MazeRenderModel | null
  frame?: MazeRenderFrame
  theme?: Partial<MazeRenderTheme>
  mode?: MazeCanvasMode
  singlePointerAction?: 'auto' | 'pan' | 'edit' | 'zoom'
  preferWallHit?: boolean
  commitEditOnPinch?: boolean
  disabled?: boolean
  className?: string
  style?: CSSProperties
  ariaLabel?: string
  rendererOptions?: MazeCanvasRendererOptions
  onEditGesture?: (gesture: MazeEditGesture) => void
  onSwipe?: (direction: MazeDirection) => void
  onViewportChange?: (viewport: Readonly<MazeViewport>) => void
  onDoubleTap?: (point: MazeScreenPoint) => void
  onRendererReady?: (renderer: MazeCanvasRenderer) => void
}

export interface MazeCanvasHandle {
  fit: () => void
  zoomIn: () => void
  zoomOut: () => void
  draw: () => void
  getCanvas: () => HTMLCanvasElement | null
  getRenderer: () => MazeCanvasRenderer | null
}

interface PointerSample {
  id: number
  x: number
  y: number
  startX: number
  startY: number
  pointerType: string
  nativeEvent: PointerEvent
}

type GestureKind =
  | 'none'
  | 'pan'
  | 'edit-pending'
  | 'edit'
  | 'zoom'
  | 'swipe'
  | 'pinch'

interface GestureState {
  kind: GestureKind
  id: number
  primaryPointerId: number | null
  lastPoint: MazeScreenPoint
  pinchDistance: number
  pinchMidpoint: MazeScreenPoint
  editedKeys: Set<string>
  wallOrientation: 'horizontal' | 'vertical' | null
  moved: boolean
}

const initialGesture = (): GestureState => ({
  kind: 'none',
  id: 0,
  primaryPointerId: null,
  lastPoint: { x: 0, y: 0 },
  pinchDistance: 0,
  pinchMidpoint: { x: 0, y: 0 },
  editedKeys: new Set(),
  wallOrientation: null,
  moved: false,
})

const midpoint = (a: PointerSample, b: PointerSample): MazeScreenPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
})

const pointDistance = (a: MazeScreenPoint, b: MazeScreenPoint): number =>
  Math.hypot(a.x - b.x, a.y - b.y)

const editSampleSpacing = (renderer: MazeCanvasRenderer): number =>
  Math.max(0.5, Math.min(8, renderer.getViewport().scale * 0.25))

const hitKey = (hit: MazeHit | null): string | null => {
  if (!hit) return null
  if (hit.kind === 'cell') return `${hit.row}:${hit.col}:cell`
  if (hit.wall === 'left' && hit.col > 0) {
    return `${hit.row}:${hit.col - 1}:right`
  }
  if (hit.wall === 'top' && hit.row > 0) {
    return `${hit.row - 1}:${hit.col}:bottom`
  }
  return `${hit.row}:${hit.col}:${hit.wall}`
}

const wallOrientation = (hit: MazeHit): 'horizontal' | 'vertical' | null => {
  if (hit.kind !== 'wall') return null
  return hit.wall === 'top' || hit.wall === 'bottom' ? 'horizontal' : 'vertical'
}

const screenReaderOnly: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

const containerBase: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  overscrollBehavior: 'contain',
}

const canvasBase: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
  outlineOffset: -3,
}

const pointerPoint = (
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  canvas: HTMLCanvasElement,
): MazeScreenPoint => {
  const rect = canvas.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

export const MazeCanvas = forwardRef<MazeCanvasHandle, MazeCanvasProps>(
  function MazeCanvas(
    {
      model,
      frame = {},
      theme,
      mode = 'view',
      singlePointerAction = 'auto',
      preferWallHit = false,
      commitEditOnPinch = false,
      disabled = false,
      className,
      style,
      ariaLabel = '미로 캔버스. 시작점 S에서 종료점 E까지 이동하세요.',
      rendererOptions,
      onEditGesture,
      onSwipe,
      onViewportChange,
      onDoubleTap,
      onRendererReady,
    },
    forwardedRef,
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const rendererRef = useRef<MazeCanvasRenderer | null>(null)
    const frameRef = useRef(frame)
    const pointersRef = useRef(new Map<number, PointerSample>())
    const gestureRef = useRef<GestureState>(initialGesture())
    const spacePressedRef = useRef(false)
    const drawFrameRef = useRef<number | null>(null)
    const gestureCounterRef = useRef(0)
    const lastTapRef = useRef<{ at: number; point: MazeScreenPoint } | null>(null)
    const callbackRef = useRef({
      onEditGesture,
      onSwipe,
      onViewportChange,
      onDoubleTap,
    })
    callbackRef.current = { onEditGesture, onSwipe, onViewportChange, onDoubleTap }
    frameRef.current = frame
    const resolvedPointerAction =
      singlePointerAction !== 'auto'
        ? singlePointerAction
        : mode === 'view'
          ? 'pan'
          : mode === 'edit'
            ? 'edit'
            : 'swipe'

    const draw = useCallback(() => {
      if (drawFrameRef.current !== null) return
      const run = (): void => {
        drawFrameRef.current = null
        rendererRef.current?.render(frameRef.current)
      }
      drawFrameRef.current =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(run)
          : window.setTimeout(run, 16)
    }, [])

    const notifyViewport = useCallback(() => {
      const renderer = rendererRef.current
      if (!renderer) return
      callbackRef.current.onViewportChange?.(renderer.getViewport())
    }, [])

    useLayoutEffect(() => {
      const canvas = canvasRef.current
      const container = containerRef.current
      if (!canvas || !container) return
      const renderer = new MazeCanvasRenderer(canvas, {
        ...rendererOptions,
        theme: { ...rendererOptions?.theme, ...theme },
      })
      rendererRef.current = renderer

      const resize = (): void => {
        const rect = container.getBoundingClientRect()
        renderer.resize(rect.width, rect.height)
        renderer.render(frameRef.current)
      }
      resize()
      renderer.setModel(model)
      renderer.render(frameRef.current)
      onRendererReady?.(renderer)

      let resizeObserver: ResizeObserver | null = null
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(resize)
        resizeObserver.observe(container)
      } else {
        window.addEventListener('resize', resize)
      }
      return () => {
        resizeObserver?.disconnect()
        window.removeEventListener('resize', resize)
        if (drawFrameRef.current !== null) {
          if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(drawFrameRef.current)
          } else {
            window.clearTimeout(drawFrameRef.current)
          }
          drawFrameRef.current = null
        }
        renderer.dispose()
        rendererRef.current = null
      }
      // Renderer construction options are intentionally mount-time settings.
      // Theme and model have dedicated effects below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
      rendererRef.current?.setModel(model)
      draw()
    }, [draw, model])

    useEffect(() => {
      rendererRef.current?.setTheme({
        ...DEFAULT_MAZE_RENDER_THEME,
        ...rendererOptions?.theme,
        ...theme,
      })
      draw()
    }, [draw, rendererOptions?.theme, theme])

    useEffect(() => {
      draw()
    }, [draw, frame])

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        const canvas = canvasRef.current
        if (!canvas || disabled) return
        const hasCanvasFocus =
          document.activeElement === canvas || containerRef.current?.contains(document.activeElement)
        if (event.code === 'Space' && hasCanvasFocus) {
          spacePressedRef.current = true
          event.preventDefault()
          return
        }
        if (mode !== 'play' || !hasCanvasFocus || event.repeat) return
        const keyDirections: Record<string, MazeDirection | undefined> = {
          ArrowUp: 'up',
          KeyW: 'up',
          ArrowRight: 'right',
          KeyD: 'right',
          ArrowDown: 'down',
          KeyS: 'down',
          ArrowLeft: 'left',
          KeyA: 'left',
        }
        const direction = keyDirections[event.code]
        if (direction) {
          event.preventDefault()
          callbackRef.current.onSwipe?.(direction)
        }
      }
      const onKeyUp = (event: KeyboardEvent): void => {
        if (event.code === 'Space') spacePressedRef.current = false
      }
      const onBlur = (): void => {
        spacePressedRef.current = false
      }
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      window.addEventListener('blur', onBlur)
      return () => {
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('keyup', onKeyUp)
        window.removeEventListener('blur', onBlur)
      }
    }, [disabled, mode])

    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const onWheel = (event: WheelEvent): void => {
        if (disabled) return
        event.preventDefault()
        const renderer = rendererRef.current
        if (!renderer) return
        const point = pointerPoint(event, canvas)
        renderer.zoomAt(Math.exp(-event.deltaY * 0.0015), point)
        notifyViewport()
        draw()
      }
      canvas.addEventListener('wheel', onWheel, { passive: false })
      return () => canvas.removeEventListener('wheel', onWheel)
    }, [disabled, draw, notifyViewport])

    useImperativeHandle(
      forwardedRef,
      () => ({
        fit: () => {
          rendererRef.current?.fit()
          notifyViewport()
          draw()
        },
        zoomIn: () => {
          const renderer = rendererRef.current
          const canvas = canvasRef.current
          if (!renderer || !canvas) return
          renderer.zoomAt(1.25, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 })
          notifyViewport()
          draw()
        },
        zoomOut: () => {
          const renderer = rendererRef.current
          const canvas = canvasRef.current
          if (!renderer || !canvas) return
          renderer.zoomAt(0.8, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 })
          notifyViewport()
          draw()
        },
        draw,
        getCanvas: () => canvasRef.current,
        getRenderer: () => rendererRef.current,
      }),
      [draw, notifyViewport],
    )

    const emitEdit = useCallback(
      (
        phase: MazeEditGesture['phase'],
        sample: PointerSample,
        point: MazeScreenPoint,
      ): void => {
        const renderer = rendererRef.current
        if (!renderer) return
        const wallHitSlop =
          sample.pointerType === 'touch'
            ? 14
            : sample.pointerType === 'pen'
              ? 12
              : 8
        const hit = renderer.hitTest(point, preferWallHit, wallHitSlop)
        const gesture = gestureRef.current
        const changesMaze = phase === 'start' || phase === 'move'
        const orientation = hit ? wallOrientation(hit) : null
        if (changesMaze && orientation) {
          if (gesture.wallOrientation === null) {
            gesture.wallOrientation = orientation
          } else if (gesture.wallOrientation !== orientation) {
            return
          }
        }
        const key = hitKey(hit)
        if (changesMaze && key && gesture.editedKeys.has(key)) return
        if (changesMaze && key) gesture.editedKeys.add(key)
        callbackRef.current.onEditGesture?.({
          phase,
          hit,
          pointerId: sample.id,
          gestureId: gesture.id,
          originalEvent: sample.nativeEvent,
        })
      },
      [preferWallHit],
    )

    const emitInterpolatedEdits = useCallback(
      (
        sample: PointerSample,
        from: MazeScreenPoint,
        to: MazeScreenPoint,
      ): void => {
        const renderer = rendererRef.current
        if (!renderer) return
        const distance = pointDistance(from, to)
        const segmentCount = Math.max(
          1,
          Math.ceil(distance / editSampleSpacing(renderer)),
        )
        for (let segment = 1; segment <= segmentCount; segment += 1) {
          const progress = segment / segmentCount
          emitEdit('move', sample, {
            x: from.x + (to.x - from.x) * progress,
            y: from.y + (to.y - from.y) * progress,
          })
        }
      },
      [emitEdit],
    )

    const beginPinch = useCallback((): void => {
      const samples = [...pointersRef.current.values()]
      if (samples.length < 2) return
      const previousGesture = gestureRef.current
      if (
        previousGesture.kind === 'edit' &&
        previousGesture.primaryPointerId !== null
      ) {
        const previousSample = pointersRef.current.get(
          previousGesture.primaryPointerId,
        )
        if (previousSample) {
          emitEdit(commitEditOnPinch ? 'end' : 'cancel', previousSample, {
            x: previousSample.x,
            y: previousSample.y,
          })
        }
      }
      const [first, second] = samples
      const center = midpoint(first, second)
      gestureRef.current.kind = 'pinch'
      gestureRef.current.primaryPointerId = null
      gestureRef.current.pinchMidpoint = center
      gestureRef.current.pinchDistance = Math.max(1, pointDistance(first, second))
      gestureRef.current.moved = true
      gestureRef.current.editedKeys.clear()
    }, [commitEditOnPinch, emitEdit])

    const onPointerDown = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>): void => {
        if (disabled || !rendererRef.current) return
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture?.(event.pointerId)
        const point = pointerPoint(event.nativeEvent, event.currentTarget)
        const sample: PointerSample = {
          id: event.pointerId,
          x: point.x,
          y: point.y,
          startX: point.x,
          startY: point.y,
          pointerType: event.pointerType,
          nativeEvent: event.nativeEvent,
        }
        pointersRef.current.set(event.pointerId, sample)

        if (pointersRef.current.size >= 2) {
          beginPinch()
          return
        }

        const gesture = gestureRef.current
        gesture.id = ++gestureCounterRef.current
        gesture.primaryPointerId = event.pointerId
        gesture.lastPoint = point
        gesture.editedKeys = new Set()
        gesture.wallOrientation = null
        gesture.moved = false
        const forcePan = spacePressedRef.current || event.button === 1
        if (forcePan || resolvedPointerAction === 'pan') {
          gesture.kind = 'pan'
        } else if (resolvedPointerAction === 'zoom') {
          gesture.kind = 'zoom'
        } else if (resolvedPointerAction === 'edit') {
          gesture.kind = event.pointerType === 'touch' || preferWallHit ? 'edit-pending' : 'edit'
          if (gesture.kind === 'edit') emitEdit('start', sample, point)
        } else {
          gesture.kind = 'swipe'
        }
      },
      [beginPinch, disabled, emitEdit, preferWallHit, resolvedPointerAction],
    )

    const onPointerMove = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>): void => {
        if (disabled) return
        const sample = pointersRef.current.get(event.pointerId)
        const renderer = rendererRef.current
        if (!sample || !renderer) return
        const point = pointerPoint(event.nativeEvent, event.currentTarget)
        const previousPoint = { x: sample.x, y: sample.y }
        sample.x = point.x
        sample.y = point.y
        sample.nativeEvent = event.nativeEvent

        if (pointersRef.current.size >= 2) {
          if (gestureRef.current.kind !== 'pinch') beginPinch()
          const samples = [...pointersRef.current.values()]
          const [first, second] = samples
          const center = midpoint(first, second)
          const distance = Math.max(1, pointDistance(first, second))
          const gesture = gestureRef.current
          renderer.zoomAt(distance / Math.max(1, gesture.pinchDistance), gesture.pinchMidpoint)
          renderer.panBy(
            center.x - gesture.pinchMidpoint.x,
            center.y - gesture.pinchMidpoint.y,
          )
          gesture.pinchDistance = distance
          gesture.pinchMidpoint = center
          notifyViewport()
          draw()
          return
        }

        const gesture = gestureRef.current
        const movement = pointDistance(
          { x: sample.startX, y: sample.startY },
          point,
        )
        if (movement > 3) gesture.moved = true

        if (gesture.kind === 'pan') {
          renderer.panBy(point.x - gesture.lastPoint.x, point.y - gesture.lastPoint.y)
          gesture.lastPoint = point
          notifyViewport()
          draw()
        } else if (gesture.kind === 'zoom') {
          const deltaY = point.y - gesture.lastPoint.y
          if (Math.abs(deltaY) > 0.1) {
            renderer.zoomAt(Math.exp(-deltaY * 0.012), gesture.lastPoint)
            gesture.lastPoint = point
            notifyViewport()
            draw()
          }
        } else if (gesture.kind === 'edit-pending' && movement > 4) {
          gesture.kind = 'edit'
          const startPoint = { x: sample.startX, y: sample.startY }
          if (preferWallHit) {
            gesture.wallOrientation =
              Math.abs(point.x - startPoint.x) >= Math.abs(point.y - startPoint.y)
                ? 'horizontal'
                : 'vertical'
          }
          emitEdit('start', sample, startPoint)
          emitInterpolatedEdits(sample, startPoint, point)
        } else if (gesture.kind === 'edit') {
          emitInterpolatedEdits(sample, previousPoint, point)
        }
      },
      [
        beginPinch,
        disabled,
        draw,
        emitEdit,
        emitInterpolatedEdits,
        notifyViewport,
        preferWallHit,
      ],
    )

    const finishPointer = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>): void => {
        const sample = pointersRef.current.get(event.pointerId)
        if (!sample) return
        const point = pointerPoint(event.nativeEvent, event.currentTarget)
        const gesture = gestureRef.current
        sample.nativeEvent = event.nativeEvent

        if (gesture.primaryPointerId === event.pointerId) {
          if (gesture.kind === 'edit-pending') {
            const startPoint = { x: sample.startX, y: sample.startY }
            emitEdit('start', sample, startPoint)
            emitInterpolatedEdits(sample, startPoint, point)
            emitEdit('end', sample, point)
          } else if (gesture.kind === 'edit') {
            emitInterpolatedEdits(
              sample,
              { x: sample.x, y: sample.y },
              point,
            )
            emitEdit('end', sample, point)
          } else if (gesture.kind === 'swipe') {
            const deltaX = point.x - sample.startX
            const deltaY = point.y - sample.startY
            if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 18) {
              const direction: MazeDirection =
                Math.abs(deltaX) > Math.abs(deltaY)
                  ? deltaX > 0
                    ? 'right'
                    : 'left'
                  : deltaY > 0
                    ? 'down'
                    : 'up'
              callbackRef.current.onSwipe?.(direction)
            }
          } else if (gesture.kind === 'zoom' && !gesture.moved) {
            rendererRef.current?.zoomAt(event.shiftKey ? 0.8 : 1.4, point)
            notifyViewport()
            draw()
          }

          if (
            sample.pointerType === 'touch' &&
            mode !== 'play' &&
            !gesture.moved &&
            gesture.kind !== 'edit' &&
            gesture.kind !== 'edit-pending' &&
            gesture.kind !== 'zoom'
          ) {
            const now = performance.now()
            const last = lastTapRef.current
            if (last && now - last.at < 320 && pointDistance(last.point, point) < 32) {
              rendererRef.current?.zoomAt(1.7, point)
              callbackRef.current.onDoubleTap?.(point)
              notifyViewport()
              draw()
              lastTapRef.current = null
            } else {
              lastTapRef.current = { at: now, point }
            }
          }
        }

        pointersRef.current.delete(event.pointerId)
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (pointersRef.current.size < 2) {
          gestureRef.current = initialGesture()
        } else {
          beginPinch()
        }
      },
      [
        beginPinch,
        draw,
        emitEdit,
        emitInterpolatedEdits,
        mode,
        notifyViewport,
      ],
    )

    const cancelPointer = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>): void => {
        const sample = pointersRef.current.get(event.pointerId)
        const gesture = gestureRef.current
        if (
          sample &&
          gesture.primaryPointerId === event.pointerId &&
          gesture.kind === 'edit'
        ) {
          emitEdit(
            'cancel',
            sample,
            pointerPoint(event.nativeEvent, event.currentTarget),
          )
        }
        pointersRef.current.delete(event.pointerId)
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (pointersRef.current.size < 2) {
          gestureRef.current = initialGesture()
        } else {
          beginPinch()
        }
      },
      [beginPinch, emitEdit],
    )

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ ...containerBase, ...style }}
        data-maze-canvas-mode={mode}
      >
        <canvas
          ref={canvasRef}
          style={{
            ...canvasBase,
            cursor:
              disabled
                ? 'default'
                : resolvedPointerAction === 'edit'
                  ? 'crosshair'
                  : resolvedPointerAction === 'zoom'
                    ? 'zoom-in'
                  : mode === 'play'
                    ? 'default'
                    : 'grab',
          }}
          role={mode === 'play' ? 'application' : 'img'}
          aria-label={ariaLabel}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={cancelPointer}
          onLostPointerCapture={cancelPointer}
          onContextMenu={(event) => mode === 'edit' && event.preventDefault()}
        />
        <span style={screenReaderOnly} aria-live="polite">
          {mode === 'edit'
            ? '미로 편집 모드'
            : mode === 'play'
              ? '미로 플레이 모드. 방향키 또는 W A S D로 이동할 수 있습니다.'
              : '미로 보기 모드'}
        </span>
      </div>
    )
  },
)
