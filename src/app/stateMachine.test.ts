import { describe, expect, it } from 'vitest'
import { initialMachineSnapshot, transitionAppState } from './stateMachine'

describe('application state machine', () => {
  it('keeps unsupported transitions unchanged', () => {
    expect(transitionAppState(initialMachineSnapshot, { type: 'PLAY' })).toBe(initialMachineSnapshot)
  })

  it('models creation, generation, play and stop independently', () => {
    let state = transitionAppState(initialMachineSnapshot, { type: 'NEW_PROJECT' })
    state = transitionAppState(state, { type: 'GENERATE' })
    expect(state.value).toBe('generating')
    state = transitionAppState(state, { type: 'GENERATED' })
    state = transitionAppState(state, { type: 'PLAY' })
    expect(state.value).toBe('playing')
    state = transitionAppState(state, { type: 'STOP' })
    expect(state.value).toBe('ready')
  })
})
