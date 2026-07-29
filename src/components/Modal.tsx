import {
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDialogA11y } from './dialogA11y'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
  closeLabel?: string
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  width?: number | string
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'grid',
  placeItems: 'center',
  padding: 16,
  background: 'rgba(9, 15, 28, 0.52)',
  overscrollBehavior: 'contain',
}

const panelStyle: CSSProperties = {
  width: 'min(100%, 640px)',
  maxHeight: 'min(88dvh, 840px)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  color: 'var(--mc-text, var(--ink, #172033))',
  background: 'var(--mc-surface, var(--surface, #ffffff))',
  border:
    '1px solid var(--mc-border, var(--line, rgba(100, 116, 139, 0.24)))',
  borderRadius: 18,
  boxShadow: '0 24px 70px rgba(9, 15, 28, 0.28)',
}

const iconButtonStyle: CSSProperties = {
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

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  closeLabel = '닫기',
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
  width,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useDialogA11y(open, panelRef, onClose, { closeOnEscape, initialFocusRef })
  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="mc-modal-backdrop"
      style={backdropStyle}
      onPointerDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={panelRef}
        className={`mc-modal${className ? ` ${className}` : ''}`}
        style={{ ...panelStyle, ...(width ? { width } : {}) }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header
          className="mc-modal__header"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '18px 18px 12px 22px',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: 20, lineHeight: 1.35 }}>
              {title}
            </h2>
            {description ? (
              <div
                id={descriptionId}
                style={{
                  marginTop: 5,
                  color: 'var(--mc-text-muted, var(--muted, #667085))',
                  fontSize: 14,
                  lineHeight: 1.55,
                }}
              >
                {description}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            style={iconButtonStyle}
            className="mc-modal__close"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          >
            <X size={21} aria-hidden="true" />
          </button>
        </header>
        <div
          className="mc-modal__body"
          style={{ minHeight: 0, overflow: 'auto', padding: '8px 22px 22px' }}
        >
          {children}
        </div>
        {footer ? (
          <footer
            className="mc-modal__footer"
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              flexWrap: 'wrap',
              gap: 10,
              padding: '14px 22px',
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
