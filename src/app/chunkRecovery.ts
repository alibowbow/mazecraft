import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

const RELOAD_KEY = 'mazecraft.stale-chunk-reload'
const RELOAD_WINDOW_MS = 60_000
let reloading = false

/** The errors browsers raise when a lazily loaded file cannot be fetched. */
export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /dynamically imported module|Importing a module script failed|Failed to load module script|Unable to preload CSS|ChunkLoadError/i.test(text)
}

/**
 * After a redeploy an open tab can ask for files the new version no longer
 * serves. Reload once to pick up the current version. A second failure within
 * a minute is a real outage: it is shown to the user instead of looping.
 */
export function reloadForStaleChunk(): boolean {
  if (reloading) return true
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Number.isFinite(last) && Date.now() - last < RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return false
  }
  reloading = true
  window.location.reload()
  return true
}

/** React.lazy that reloads the page when a stale deployment lost the screen's file. */
export function lazyScreen<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyExoticComponent<T> {
  return lazy(() => load().catch((error: unknown) => {
    // Keep the loading screen up while the page reloads.
    if (isChunkLoadError(error) && reloadForStaleChunk()) return new Promise<never>(() => undefined)
    throw error
  }))
}

/** Vite reports failed preloads of a dynamic import's dependencies here. */
export function installChunkRecovery(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForStaleChunk()) event.preventDefault()
  })
}
