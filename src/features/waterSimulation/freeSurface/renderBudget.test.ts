import { describe, expect, it } from 'vitest'
import { RenderPerformanceBudget } from './renderBudget'

describe('rendering performance budget', () => {
  it('reduces persistent GPU workload and respects its quality floor', () => {
    const budget = new RenderPerformanceBudget()
    for (let i = 0; i < 15; i++) budget.observe(50)
    expect(budget.scale).toBe(0.85)
    for (let i = 0; i < 100; i++) budget.observe(50)
    expect(budget.scale).toBe(0.6)
  })
  it('ignores isolated stalls and retains full detail on a smooth display', () => {
    const budget = new RenderPerformanceBudget()
    budget.observe(5_000); budget.observe(NaN)
    for (let i = 0; i < 1_000; i++) budget.observe(16.7)
    expect(budget.scale).toBe(1)
  })
  it('requires sustained headroom to recover without resolution flicker', () => {
    const budget = new RenderPerformanceBudget()
    for (let i = 0; i < 15; i++) budget.observe(50)
    for (let i = 0; i < 200; i++) budget.observe(16.7)
    expect(budget.scale).toBe(0.85)
    for (let i = 0; i < 160; i++) budget.observe(16.7)
    expect(budget.scale).toBe(1)
  })
  it('also reduces detail for sustained sub-4fps overload, not scattered stalls', () => {
    const budget = new RenderPerformanceBudget()
    for (let i = 0; i < 10; i++) { budget.observe(400); budget.observe(16.7) }
    expect(budget.scale).toBe(1)
    budget.observe(400); budget.observe(400)
    expect(budget.scale).toBe(1)
    expect(budget.observe(400)).toBe(true)
    expect(budget.scale).toBe(0.85)
    for (let i = 0; i < 12; i++) budget.observe(400)
    expect(budget.scale).toBe(0.6)
  })
})
