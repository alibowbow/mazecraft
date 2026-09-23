import type { GardenId } from './designs'

export type { GardenId } from './designs'
/** A preset rendered as an authored water garden rather than an extruded grid. */
export type GardenSculpture = `garden:${GardenId}`
export type WaterSculpture = GardenSculpture | 'extruded-flow'

export function gardenIdOf(sculpture: WaterSculpture | undefined): GardenId | null {
  return sculpture?.startsWith('garden:') ? sculpture.slice(7) as GardenId : null
}
