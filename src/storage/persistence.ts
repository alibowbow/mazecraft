export interface StorageState {
  /** Bytes this site uses and may use, when the browser reports them. */
  usage: number | null
  quota: number | null
  /** True when the browser promised not to evict this site's data. */
  persisted: boolean | null
}

type StorageManagerLike = Pick<StorageManager, 'estimate' | 'persist' | 'persisted'>

function manager(): StorageManagerLike | null {
  return typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function'
    ? navigator.storage
    : null
}

export async function readStorageState(): Promise<StorageState> {
  const storage = manager()
  if (!storage) return { usage: null, quota: null, persisted: null }
  const [estimate, persisted] = await Promise.all([
    storage.estimate().catch(() => null),
    typeof storage.persisted === 'function' ? storage.persisted().catch(() => null) : Promise.resolve(null),
  ])
  return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted }
}

/**
 * Ask the browser to keep this site's data under storage pressure. Some
 * browsers decide silently, Firefox asks the visitor; call it from a click.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = manager()
  if (!storage || typeof storage.persist !== 'function') return false
  try {
    return await storage.persist()
  } catch {
    return false
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
}

/** A save failure explained in terms the visitor can act on. */
export function describeStorageError(error: unknown): string {
  const name = error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException) ? error.name : ''
  if (name === 'QuotaExceededError' || /quota/i.test(String(error))) {
    return '저장 공간이 부족해 저장하지 못했습니다. 쓰지 않는 프로젝트를 백업한 뒤 삭제해 공간을 확보해 주세요.'
  }
  return '이 기기에 저장하지 못했습니다. 잠시 후 다시 시도하거나 프로젝트 파일로 내보내 보관해 주세요.'
}
