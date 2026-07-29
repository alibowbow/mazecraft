import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface DialogProps {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  labelledBy?: string
}

export function Dialog({ title, children, footer, onClose, labelledBy = 'dialog-title' }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement as HTMLElement | null
    const focusable = dialog?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    focusable?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const items = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  return (
    <div className="dialog-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <header className="dialog-header">
          <h2 id={labelledBy}>{title}</h2>
          <button className="icon-button" aria-label="닫기" onClick={onClose}><X size={19} /></button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-actions">{footer}</footer>}
      </section>
    </div>
  )
}
