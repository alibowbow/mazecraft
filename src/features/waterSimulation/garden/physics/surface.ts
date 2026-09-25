import type { GardenLayout } from '../layout'
import { gardenField } from '../flowField'
import { PhysicsWorld } from './world'

/** Texel grid of the plan textures: world x0, y0, texel size, width, height. */
export interface SurfaceGrid { x0: number; y0: number; cell: number; width: number; height: number }

/** Surface height written where a texel holds no water and no neighbour does. */
export const NO_WATER = -100

/**
 * How the basin grids map onto one plan texture over the garden field, and
 * the beds they simulate. Shared by the simulation (to publish the water)
 * and the renderer (to build beds that match the physics exactly).
 */
export interface SurfacePlan {
  grid: SurfaceGrid
  /** Per texel: owning basin grid (or -1) and its cell. */
  texelDomain: Int16Array
  texelCell: Int32Array
  /** Vessel whose water is drawn at each texel (-1: none). */
  texelVessel: Int16Array
  /** Bed height per texel (absolute), carried a few texels under the walls. */
  bed: Float32Array
}

const plans = new WeakMap<GardenLayout, SurfacePlan>()

export function surfacePlan(layout: GardenLayout, world?: PhysicsWorld): SurfacePlan {
  const cached = plans.get(layout)
  if (cached) return cached
  const source = world ?? new PhysicsWorld(layout)
  const field = gardenField(layout)
  const dx = source.dx, [fx0, fy0, fw, fh] = field.bounds
  const grid: SurfaceGrid = { x0: fx0, y0: fy0, cell: dx, width: Math.ceil(fw / dx), height: Math.ceil(fh / dx) }
  const texels = grid.width * grid.height
  const texelDomain = new Int16Array(texels).fill(-1)
  const texelCell = new Int32Array(texels).fill(-1)
  const texelVessel = new Int16Array(texels).fill(-1)
  const bed = new Float32Array(texels).fill(NO_WATER)
  const fieldPool = (x: number, y: number) => {
    const i = Math.floor((x - fx0) / field.cell), j = Math.floor((y - fy0) / field.cell)
    if (i < 0 || j < 0 || i >= field.width || j >= field.height) return -1
    return field.data[(j * field.width + i) * 4 + 3] - 1
  }
  source.domains.forEach((domain, d) => {
    const g = domain.grid
    const ti0 = Math.round((g.x0 - fx0) / dx), tj0 = Math.round((g.y0 - fy0) / dx)
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const c = j * g.nx + i
      if (g.solid[c] || domain.poolOf[c] < 0) continue
      const ti = ti0 + i, tj = tj0 + j
      if (ti < 0 || tj < 0 || ti >= grid.width || tj >= grid.height) continue
      const t = tj * grid.width + ti
      // Where basins overlap in plan (a spout over the pool below), the
      // pool drawn there owns the texel.
      const owner = fieldPool(fx0 + (ti + 0.5) * dx, fy0 + (tj + 0.5) * dx)
      const mine = owner >= 0 && layout.pools[owner].vessel === domain.vessel
      if (texelDomain[t] >= 0 && !mine) continue
      texelDomain[t] = d; texelCell[t] = c; texelVessel[t] = domain.vessel
      bed[t] = g.bed[c]
    }
  })
  // Carry the beds on under the walls so filtering never mixes in a hole.
  for (let pass = 0; pass < 4; pass++) {
    const previous = bed.slice()
    for (let j = 1; j < grid.height - 1; j++) for (let i = 1; i < grid.width - 1; i++) {
      const t = j * grid.width + i
      if (previous[t] > NO_WATER + 1) continue
      let sum = 0, n = 0
      for (const k of [t - 1, t + 1, t - grid.width, t + grid.width]) if (previous[k] > NO_WATER + 1) { sum += previous[k]; n++ }
      if (n) bed[t] = sum / n
    }
  }
  const plan = { grid, texelDomain, texelCell, texelVessel, bed }
  plans.set(layout, plan)
  return plan
}
