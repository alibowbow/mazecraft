import { useEffect, useRef, type CSSProperties, type PointerEvent } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react'
import type { MazeDirection } from '../renderer/types'

export interface DPadProps {
  onMove: (direction: MazeDirection) => void
  disabled?: boolean
  repeatDelayMs?: number
  repeatIntervalMs?: number
  className?: string
  style?: CSSProperties
}

const directions: ReadonlyArray<{
  direction: MazeDirection
  label: string
  gridArea: string
  icon: typeof ChevronUp
}> = [
  { direction: 'up', label: '위로 이동', gridArea: 'up', icon: ChevronUp },
  { direction: 'left', label: '왼쪽으로 이동', gridArea: 'left', icon: ChevronLeft },
  { direction: 'right', label: '오른쪽으로 이동', gridArea: 'right', icon: ChevronRight },
  { direction: 'down', label: '아래로 이동', gridArea: 'down', icon: ChevronDown },
]

export function DPad({
  onMove,
  disabled = false,
  repeatDelayMs = 280,
  repeatIntervalMs = 92,
  className,
  style,
}: DPadProps) {
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activePointerRef = useRef<number | null>(null)
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  const stopRepeating = (event?: PointerEvent<HTMLButtonElement>): void => {
    if (
      event &&
      activePointerRef.current !== null &&
      event.pointerId !== activePointerRef.current
    ) {
      return
    }
    if (delayRef.current !== null) clearTimeout(delayRef.current)
    if (intervalRef.current !== null) clearInterval(intervalRef.current)
    delayRef.current = null
    intervalRef.current = null
    activePointerRef.current = null
  }

  useEffect(() => () => stopRepeating(), [])
  useEffect(() => {
    if (disabled) stopRepeating()
  }, [disabled])

  const startRepeating = (
    direction: MazeDirection,
    event: PointerEvent<HTMLButtonElement>,
  ): void => {
    if (disabled) return
    stopRepeating()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    activePointerRef.current = event.pointerId
    onMoveRef.current(direction)
    delayRef.current = setTimeout(() => {
      intervalRef.current = setInterval(
        () => onMoveRef.current(direction),
        Math.max(45, repeatIntervalMs),
      )
    }, Math.max(120, repeatDelayMs))
  }

  return (
    <div
      className={`mc-dpad${className ? ` ${className}` : ''}`}
      aria-label="화면 방향 패드"
      style={{
        width: 150,
        height: 150,
        display: 'grid',
        gridTemplateAreas: '". up ." "left center right" ". down ."',
        gridTemplateColumns: 'repeat(3, 50px)',
        gridTemplateRows: 'repeat(3, 50px)',
        touchAction: 'none',
        userSelect: 'none',
        ...style,
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span
        aria-hidden="true"
        style={{
          gridArea: 'center',
          placeSelf: 'center',
          width: 30,
          height: 30,
          borderRadius: '50%',
          background:
            'var(--mc-dpad-center, var(--surface-3, rgba(100, 116, 139, 0.2)))',
        }}
      />
      {directions.map(({ direction, label, gridArea, icon: Icon }) => (
        <button
          key={direction}
          type="button"
          disabled={disabled}
          aria-label={label}
          title={label}
          style={{
            gridArea,
            width: 48,
            height: 48,
            placeSelf: 'center',
            display: 'grid',
            placeItems: 'center',
            padding: 0,
            color: 'var(--mc-text, var(--ink, #172033))',
            background:
              'var(--mc-control, var(--surface, rgba(255, 255, 255, 0.94)))',
            border:
              '1px solid var(--mc-border, var(--line, rgba(100, 116, 139, 0.34)))',
            borderRadius: 14,
            boxShadow: '0 4px 12px rgba(15, 23, 42, 0.12)',
            opacity: disabled ? 0.5 : 1,
            touchAction: 'none',
          }}
          onPointerDown={(event) => startRepeating(direction, event)}
          onPointerUp={stopRepeating}
          onPointerCancel={stopRepeating}
          onLostPointerCapture={stopRepeating}
          onKeyDown={(event) => {
            // Native keyboard activation already emits one click. Prevent the
            // pointer repeat timers from being involved in keyboard control.
            if (event.repeat && (event.key === ' ' || event.key === 'Enter')) {
              event.preventDefault()
              onMoveRef.current(direction)
            }
          }}
          onClick={(event) => {
            // Pointer-down already performed the move; click is retained for
            // keyboard and assistive-technology activation only.
            if (event.detail === 0) onMoveRef.current(direction)
          }}
        >
          <Icon size={24} strokeWidth={2.25} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
