import { useEffect, useRef, type RefObject } from 'react'

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const visibleFocusableElements = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) =>
      element.getAttribute('aria-hidden') !== 'true' &&
      (element.offsetWidth > 0 || element.offsetHeight > 0 || element === document.activeElement),
  )

export const useDialogA11y = (
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { closeOnEscape?: boolean; initialFocusRef?: RefObject<HTMLElement | null> } = {},
): void => {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const focusFrame = window.requestAnimationFrame(() => {
      const next =
        options.initialFocusRef?.current ??
        (panel ? visibleFocusableElements(panel)[0] : null) ??
        panel
      next?.focus({ preventScroll: true })
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      const currentPanel = panelRef.current
      if (!currentPanel) return
      if (event.key === 'Escape' && options.closeOnEscape !== false) {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = visibleFocusableElements(currentPanel)
      if (focusable.length === 0) {
        event.preventDefault()
        currentPanel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown)
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [open, options.closeOnEscape, options.initialFocusRef, panelRef])
}
