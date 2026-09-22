import type { BasinSnapshot } from './basinSimulation'

export interface CascadeState {
  readonly time: number
  readonly depths: readonly [number, number, number]
  readonly sourceRate: number
  /** Upper → middle, middle → lower, lower → receiving trough. */
  readonly discharge: readonly [number, number, number]
}

export interface CascadeSnapshot extends BasinSnapshot {
  readonly cascade: CascadeState
}

/** World Z is up. Upper, central and lower basin floors are actual geometry. */
export const CASCADE_FLOORS = [1.9, 0.95, 0] as const
export const CASCADE_INITIAL_DEPTH = 0.46
export const CASCADE_SILL_DEPTH = 0.28
export const CASCADE_WALL_HEIGHT = 0.98
export const CASCADE_AREAS = [17, 23, 18] as const
export const CASCADE_SPILLS = [
  { x: -2.55, y: 1.65, width: 0.86, landingY: 1.08 },
  { x: 2.3, y: -1.7, width: 0.86, landingY: -2.27 },
  { x: 0, y: -4.25, width: 0.86, landingY: -4.94 },
] as const
