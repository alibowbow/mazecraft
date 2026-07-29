import type { MazeProject } from '../core/maze/types'
import type { ProjectRepository } from './projectRepository'

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface AutosaveStatus {
  state: AutosaveState
  savedAt?: string
  error?: Error
}

export type AutosaveListener = (status: AutosaveStatus) => void

export interface AutosaveController {
  schedule(project: MazeProject): void
  flush(): Promise<void>
  cancel(): void
  dispose(): void
}

export function createAutosave(
  repository: ProjectRepository,
  listener: AutosaveListener = () => undefined,
  delayMs = 700,
): AutosaveController {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: MazeProject | undefined
  let writePromise: Promise<void> | undefined
  let disposed = false

  const savePending = async (): Promise<void> => {
    if (writePromise) {
      await writePromise
    }
    if (!pending || disposed) return

    const project = pending
    pending = undefined
    listener({ state: 'saving' })

    writePromise = repository
      .put(project)
      .then(() => {
        listener({ state: 'saved', savedAt: new Date().toISOString() })
      })
      .catch((cause: unknown) => {
        const error =
          cause instanceof Error ? cause : new Error('자동 저장에 실패했습니다.')
        listener({ state: 'error', error })
      })
      .finally(() => {
        writePromise = undefined
      })

    await writePromise
    if (pending && !disposed) await savePending()
  }

  const saveBeforeLeaving = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    void savePending()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', saveBeforeLeaving)
  }

  return {
    schedule(project) {
      if (disposed) return
      pending = project
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void savePending()
      }, Math.max(0, delayMs))
    },

    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      await savePending()
    },

    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
      pending = undefined
      listener({ state: 'idle' })
    },

    dispose() {
      if (timer) clearTimeout(timer)
      timer = undefined
      const finalProject = pending
      pending = undefined
      disposed = true
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', saveBeforeLeaving)
      }
      if (finalProject) {
        const persistFinalProject = async () => {
          if (writePromise) await writePromise
          try {
            await repository.put(finalProject)
          } catch {
            // The UI is already gone; the next active session can surface its
            // normal storage status without triggering an unmounted update.
          }
        }
        void persistFinalProject()
      }
    },
  }
}
