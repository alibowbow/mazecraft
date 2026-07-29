import type { MazeProject } from '../core/maze/types'
import {
  MemoryProjectRepository,
  type ProjectAssetRepository,
  type ProjectRepository,
} from './projectRepository'

const DATABASE_NAME = 'mazecraft-core'
const DATABASE_VERSION = 1
const PROJECT_STORE = 'projects'
const ASSET_STORE = 'assets'

type StoredAsset = {
  id: string
  value: Blob
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    })
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('IndexedDB 요청에 실패했습니다.')),
      { once: true },
    )
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener(
      'abort',
      () =>
        reject(
          transaction.error ?? new Error('IndexedDB 작업이 중단되었습니다.'),
        ),
      { once: true },
    )
    transaction.addEventListener(
      'error',
      () =>
        reject(transaction.error ?? new Error('IndexedDB 저장에 실패했습니다.')),
      { once: true },
    )
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('이 브라우저에서는 IndexedDB를 사용할 수 없습니다.'))
      return
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    request.addEventListener('upgradeneeded', () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PROJECT_STORE)) {
        const store = database.createObjectStore(PROJECT_STORE, {
          keyPath: 'id',
        })
        store.createIndex('updatedAt', 'updatedAt')
      }
      if (!database.objectStoreNames.contains(ASSET_STORE)) {
        database.createObjectStore(ASSET_STORE, { keyPath: 'id' })
      }
    })
    request.addEventListener('success', () => {
      const database = request.result
      if (settled) {
        database.close()
        return
      }
      settled = true
      database.addEventListener('versionchange', () => database.close())
      resolve(database)
    })
    request.addEventListener(
      'error',
      () => fail(request.error ?? new Error('로컬 저장소를 열 수 없습니다.')),
      { once: true },
    )
    request.addEventListener(
      'blocked',
      () =>
        fail(
          new Error(
            '다른 탭에서 이전 버전의 메이즈크래프트가 열려 있습니다.',
          ),
        ),
      { once: true },
    )
  })
}

function projectTimestamp(project: MazeProject): number {
  const timestamp = Date.parse(String(project.updatedAt))
  return Number.isFinite(timestamp) ? timestamp : 0
}

/**
 * IndexedDB-backed repository. Browsers that cannot open IndexedDB (private
 * browsing or storage policy) keep working through an in-memory fallback.
 * Transaction and quota failures are allowed to reach the UI so a failed
 * persistent save is never reported as successful. The fallback is session-only.
 */
export class IndexedDbProjectRepository
  implements ProjectRepository, ProjectAssetRepository
{
  private readonly fallback: MemoryProjectRepository
  private readonly database: Promise<IDBDatabase | null>
  private degraded = false

  constructor(fallback = new MemoryProjectRepository()) {
    this.fallback = fallback
    this.database = openDatabase().catch(() => {
      this.degraded = true
      return null
    })
  }

  get isMemoryFallback(): boolean {
    return this.degraded
  }

  private async db(): Promise<IDBDatabase | null> {
    return this.database
  }

  async list(): Promise<MazeProject[]> {
    const database = await this.db()
    if (!database) return this.fallback.list()

    const transaction = database.transaction(PROJECT_STORE, 'readonly')
    const done = transactionDone(transaction)
    const [values] = await Promise.all([
      requestResult(
        transaction.objectStore(PROJECT_STORE).getAll() as IDBRequest<
          MazeProject[]
        >,
      ),
      done,
    ])
    return values.sort((a, b) => projectTimestamp(b) - projectTimestamp(a))
  }

  async get(id: string): Promise<MazeProject | null> {
    const database = await this.db()
    if (!database) return this.fallback.get(id)

    const transaction = database.transaction(PROJECT_STORE, 'readonly')
    const done = transactionDone(transaction)
    const [value] = await Promise.all([
      requestResult(
        transaction.objectStore(PROJECT_STORE).get(id) as IDBRequest<
          MazeProject | undefined
        >,
      ),
      done,
    ])
    return value ?? null
  }

  async put(project: MazeProject): Promise<void> {
    const database = await this.db()
    if (!database) {
      await this.fallback.put(project)
      return
    }

    const transaction = database.transaction(PROJECT_STORE, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(PROJECT_STORE).put(project)
    await done
  }

  async delete(id: string): Promise<void> {
    const database = await this.db()
    if (!database) {
      await this.fallback.delete(id)
      return
    }

    const transaction = database.transaction(PROJECT_STORE, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(PROJECT_STORE).delete(id)
    await done
  }

  async clear(): Promise<void> {
    const database = await this.db()
    if (!database) {
      await this.fallback.clear()
      return
    }

    const transaction = database.transaction(
      [PROJECT_STORE, ASSET_STORE],
      'readwrite',
    )
    const done = transactionDone(transaction)
    transaction.objectStore(PROJECT_STORE).clear()
    transaction.objectStore(ASSET_STORE).clear()
    await done
  }

  async putAsset(id: string, value: Blob): Promise<void> {
    const database = await this.db()
    if (!database) {
      await this.fallback.putAsset(id, value)
      return
    }

    const transaction = database.transaction(ASSET_STORE, 'readwrite')
    const done = transactionDone(transaction)
    const record: StoredAsset = { id, value }
    transaction.objectStore(ASSET_STORE).put(record)
    await done
  }

  async getAsset(id: string): Promise<Blob | null> {
    const database = await this.db()
    if (!database) return this.fallback.getAsset(id)

    const transaction = database.transaction(ASSET_STORE, 'readonly')
    const done = transactionDone(transaction)
    const [record] = await Promise.all([
      requestResult(
        transaction.objectStore(ASSET_STORE).get(id) as IDBRequest<
          StoredAsset | undefined
        >,
      ),
      done,
    ])
    return record?.value ?? null
  }

  async deleteAsset(id: string): Promise<void> {
    const database = await this.db()
    if (!database) {
      await this.fallback.deleteAsset(id)
      return
    }

    const transaction = database.transaction(ASSET_STORE, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(ASSET_STORE).delete(id)
    await done
  }
}

export const localProjectRepository = new IndexedDbProjectRepository()
