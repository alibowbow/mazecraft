import { describe, expect, it } from 'vitest'
import type { MazeGraph } from '../../core/maze/types'
import {
  applyPlayerMove,
  createPlayerSession,
  isTimeAttackExpired,
  movePosition,
  timeAttackLimitMs,
  timeAttackRemainingMs,
} from './playerEngine'

const graph: MazeGraph = {
  version: 1,
  rows: 1,
  cols: 2,
  algorithm: 'dfs',
  seed: 'test',
  cells: [
    { index: 0, row: 0, col: 0, active: true, walls: { top: true, right: false, bottom: true, left: true } },
    { index: 1, row: 0, col: 1, active: true, walls: { top: true, right: false, bottom: true, left: false } },
  ],
}

describe('player engine', () => {
  it('never moves outside the grid even when an outer wall is visually open', () => {
    expect(movePosition(graph, { row: 0, col: 1 }, 'right')).toEqual({ row: 0, col: 1 })
  })

  it('completes only after entering the end cell', () => {
    const session = createPlayerSession({ row: 0, col: 0 }, 0)
    const moved = applyPlayerMove(session, graph, 'right', { row: 0, col: 1 }, [{ row: 0, col: 0 }, { row: 0, col: 1 }], [], [], 100)
    expect(moved.completed).toBe(true)
    expect(moved.stats.moves).toBe(1)
    const duplicate = applyPlayerMove(moved, graph, 'left', { row: 0, col: 1 }, [], [], [], 200)
    expect(duplicate).toBe(moved)
  })

  it('ends a configured time attack exactly at its limit', () => {
    const rules = {
      mode: 'time-attack' as const,
      timeLimitSeconds: 12,
    }
    expect(timeAttackLimitMs(rules)).toBe(12_000)
    expect(timeAttackRemainingMs(rules, 11_250)).toBe(750)
    expect(isTimeAttackExpired(rules, 11_999)).toBe(false)
    expect(isTimeAttackExpired(rules, 12_000)).toBe(true)
    expect(timeAttackRemainingMs(rules, 14_000)).toBe(0)
  })

  it('does not apply a timer to classic mode or an invalid limit', () => {
    expect(
      timeAttackLimitMs({ mode: 'classic', timeLimitSeconds: 10 }),
    ).toBeNull()
    expect(
      timeAttackLimitMs({ mode: 'time-attack', timeLimitSeconds: 0 }),
    ).toBeNull()
  })
})
