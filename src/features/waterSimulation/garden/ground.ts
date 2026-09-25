import * as THREE from 'three'
import type { GardenField } from './flowField'

/** A round island on the sand (a stone group or planting) the rake goes around. */
export type SandIsland = readonly [x: number, y: number, radius: number]

const FAR = 1e20

/** 1D squared distance transform (Felzenszwalb & Huttenlocher) of f into d. */
function transform1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]) }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/**
 * Exact Euclidean distance (m) from each plan cell to the sculpture's
 * footprint and to the islands on the sand: the rake lines of the ground
 * follow its contours, as in a raked gravel garden.
 */
export function sandDistances(field: GardenField, islands: readonly SandIsland[] = []): Float32Array {
  const { width, height, cell, data } = field
  const [x0, y0] = field.bounds
  const grid = new Float64Array(width * height)
  // Ground cells carry the outside distance in the upper half of B; the
  // footprint (walls, rims and pools) is everything below it.
  for (let i = 0; i < grid.length; i++) grid[i] = data[i * 4 + 2] < 128 ? 0 : FAR
  const size = Math.max(width, height)
  const f = new Float64Array(size), d = new Float64Array(size), v = new Int32Array(size), z = new Float64Array(size + 1)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]
    transform1d(f, height, d, v, z)
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x]
    transform1d(f, width, d, v, z)
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x]
  }
  const result = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x
    let distance = Math.sqrt(grid[i]) * cell
    const px = x0 + (x + 0.5) * cell, py = y0 + (y + 0.5) * cell
    for (const [ix, iy, radius] of islands) distance = Math.min(distance, Math.max(0, Math.hypot(px - ix, py - iy) - radius))
    result[i] = Math.min(distance, 60)
  }
  return result
}

export function sandDistanceTexture(field: GardenField, islands: readonly SandIsland[] = []): THREE.DataTexture {
  const distances = sandDistances(field, islands)
  const texture = new THREE.DataTexture(Uint16Array.from(distances, value => THREE.DataUtils.toHalfFloat(value)), field.width, field.height, THREE.RedFormat, THREE.HalfFloatType)
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
  texture.name = 'garden-sand-distance'
  return texture
}
