export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  index: number
  length: number
}
function defaultClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

export class UndoRedoHistory<T> {
  private entries: T[]
  private cursor = 0
  private readonly limit: number
  private readonly clone: (value: T) => T

  constructor(initial: T, limit = 100, clone: (value: T) => T = defaultClone) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('History limit must be a positive integer.')
    }
    this.limit = limit
    this.clone = clone
    this.entries = [this.clone(initial)]
  }

  get current(): T {
    return this.clone(this.entries[this.cursor])
  }

  get state(): HistoryState {
    return {
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.entries.length - 1,
      index: this.cursor,
      length: this.entries.length,
    }
  }

  push(value: T): T {
    this.entries = this.entries.slice(0, this.cursor + 1)
    this.entries.push(this.clone(value))
    if (this.entries.length > this.limit + 1) {
      this.entries.shift()
    }
    this.cursor = this.entries.length - 1
    return this.current
  }

  undo(): T {
    if (this.cursor > 0) this.cursor -= 1
    return this.current
  }

  redo(): T {
    if (this.cursor < this.entries.length - 1) this.cursor += 1
    return this.current
  }

  reset(value: T): T {
    this.entries = [this.clone(value)]
    this.cursor = 0
    return this.current
  }
}
