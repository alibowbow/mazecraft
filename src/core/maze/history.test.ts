import { describe, expect, it } from 'vitest'
import { UndoRedoHistory } from './history'

describe('UndoRedoHistory', () => {
  it('supports undo, redo and branch replacement', () => {
    const history = new UndoRedoHistory({ value: 0 })
    history.push({ value: 1 })
    history.push({ value: 2 })
    expect(history.undo()).toEqual({ value: 1 })
    expect(history.redo()).toEqual({ value: 2 })
    history.undo()
    history.push({ value: 3 })
    expect(history.state.canRedo).toBe(false)
    expect(history.current).toEqual({ value: 3 })
  })

  it('retains at most 100 undo transitions by default', () => {
    const history = new UndoRedoHistory(0)
    for (let value = 1; value <= 130; value += 1) history.push(value)
    expect(history.state.length).toBe(101)
    for (let count = 0; count < 150; count += 1) history.undo()
    expect(history.current).toBe(30)
  })
})
