import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDialogA11y } from './dialogA11y'

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  maxHeight?: number | string
  closeLabel?: string
}

interface DragState {
  pointerId: number
  startY: number
  lastY: number
  startedAt: number
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  background: 'rgba(9, 15, 28, 0.48)',
  overscrollBehavior: 'contain',
}

const closeButtonStyle: CSSProperties = {
  width: 44,
  height: 44,
  flex: '0 0 44px',
  display: 'inline-grid',
  placeItems: 'center',
  padding: 0,
  color: 'inherit',
  background: 'transparent',
  border: 0,
  borderRadius: 12,
  cursor: 'pointer',
}

export function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
  maxHeight = 'min(86dvh, 760px)',
  closeLabel = '설정 닫기',
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const titleId = useId()
  const descriptionId = useId()
  useDialogA11y(open, panelRef, onClose, { closeOnEscape, initialFocusRef })

  useEffect(() => {
    if (open) {
      dragRef.current = null
      setDragOffset(0)
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      startedAt: performance.now(),
    }
  }

  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.lastY = event.clientY
    setDragOffset(Math.max(0, event.clientY - drag.startY))
  }

  const onDragEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const distance = Math.max(0, event.clientY - drag.startY)
    const elapsed = Math.max(1, performance.now() - drag.startedAt)
    const velocity = distance / elapsed
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (distance >= 88 || (distance >= 34 && velocity > 0.7)) {
      onClose()
    } else {
      setDragOffset(0)
    }
  }

  return createPortal(
    <div
      className="mc-bottom-sheet-backdrop"
      style={backdropStyle}
      onPointerDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={panelRef}
        className={`mc-bottom-sheet${className ? ` ${className}` : ''}`}
        style={{
          width: 'min(100%, 820px)',
          maxHeight,
          minHeight: 160,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: 'var(--mc-text, var(--ink, #172033))',
          background: 'var(--mc-surface, var(--surface, #ffffff))',
          border:
            '1px solid var(--mc-border, var(--line, rgba(100, 116, 139, 0.24)))',
          borderBottom: 0,
          borderRadius: '22px 22px 0 0',
          boxShadow: '0 -16px 48px rgba(9, 15, 28, 0.2)',
          transform: `translate3d(0, ${dragOffset}px, 0)`,
          transition:
            reduceMotion || dragRef.current ? 'none' : 'transform 180ms ease-out',
          willChange: dragOffset > 0 ? 'transform' : undefined,
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div
          className="mc-bottom-sheet__drag-region"
          style={{
            minHeight: 34,
            display: 'grid',
            placeItems: 'center',
            cursor: 'grab',
            touchAction: 'none',
          }}
          aria-hidden="true"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <span
            style={{
              width: 42,
              height: 5,
              borderRadius: 999,
              background:
                'var(--mc-border-strong, var(--line-strong, #a8b1c1))',
            }}
          />
        </div>
        <header
          className="mc-bottom-sheet__header"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '2px 14px 12px 20px',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: 19, lineHeight: 1.4 }}>
              {title}
            </h2>
            {description ? (
              <div
                id={descriptionId}
                style={{
                  marginTop: 4,
                  color: 'var(--mc-text-muted, var(--muted, #667085))',
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                {description}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            style={closeButtonStyle}
            className="mc-bottom-sheet__close"
            aria-label={closeLabel}
            title="닫기"
            onClick={onClose}
          >
            <X size={21} aria-hidden="true" />
          </button>
        </header>
        <div
          className="mc-bottom-sheet__body"
          style={{
            minHeight: 0,
            flex: 1,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: '8px 20px max(20px, env(safe-area-inset-bottom))',
          }}
        >
          {children}
        </div>
        {footer ? (
          <footer
            className="mc-bottom-sheet__footer"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              gap: 10,
              padding: '12px 20px max(12px, env(safe-area-inset-bottom))',
              borderTop:
                '1px solid var(--mc-border, var(--line, rgba(100, 116, 139, 0.2)))',
            }}
          >
            {footer}
          </footer>
        ) : null}
      </section>
    </div>,
    document.body,
  )
}
