import type { GardenId } from './designs'

export type { GardenId } from './designs'
/** A preset garden, or one assembled in the craft studio (registered by key). */
export type GardenKey = GardenId | `craft-${string}`
/** A preset rendered as an authored water garden rather than an extruded grid. */
export type GardenSculpture = `garden:${GardenKey}`
export type WaterSculpture = GardenSculpture | 'extruded-flow'

export function gardenIdOf(sculpture: WaterSculpture | undefined): GardenKey | null {
  return sculpture?.startsWith('garden:') ? sculpture.slice(7) as GardenKey : null
}
