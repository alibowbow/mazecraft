import type { FluidLayout } from './types'

/** Covers the largest stretched optical splat; this is not a fluid radius. */
export const WALL_CLEARANCE_SCALE = 0.42

/**
 * A conservative empty-space radius for every nearest-filtered wall texel.
 * The capped eight-neighbour distance transform is linear in mask size. A
 * point anywhere inside a texel is at least (distance - 1) texels away from
 * every occupied texel's rectangle. Using the smaller world texel dimension
 * also makes that bound valid for non-square masks.
 *
 * Encode downward, with a small floating-point guard, so a shader can skip
 * its existing visibility samples only for segments proven entirely clear.
 * R8 decoding is `sample.r * WALL_CLEARANCE_SCALE`. The original solid mask
 * remains separate and unchanged; segments beyond the bound use that mask.
 */
function buildWallClearance(data: Uint8Array, width: number, height: number, texelSize: number): Uint8Array {
  const distanceLimit = Math.min(255, Math.ceil(WALL_CLEARANCE_SCALE / texelSize) + 1)
  const clearance = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) clearance[i] = data[i] ? 0 : distanceLimit

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const index = row + x
      if (clearance[index] === 0) continue
      let distance = clearance[index]
      if (x > 0) distance = Math.min(distance, clearance[index - 1] + 1)
      if (y > 0) {
        distance = Math.min(distance, clearance[index - width] + 1)
        if (x > 0) distance = Math.min(distance, clearance[index - width - 1] + 1)
        if (x + 1 < width) distance = Math.min(distance, clearance[index - width + 1] + 1)
      }
      clearance[index] = distance
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width
    for (let x = width - 1; x >= 0; x--) {
      const index = row + x
      if (clearance[index] === 0) continue
      let distance = clearance[index]
      if (x + 1 < width) distance = Math.min(distance, clearance[index + 1] + 1)
      if (y + 1 < height) {
        distance = Math.min(distance, clearance[index + width] + 1)
        if (x > 0) distance = Math.min(distance, clearance[index + width - 1] + 1)
        if (x + 1 < width) distance = Math.min(distance, clearance[index + width + 1] + 1)
      }
      clearance[index] = distance
    }
  }

  for (let i = 0; i < clearance.length; i++) {
    const lowerBound = Math.max(0, (clearance[i] - 1) * texelSize - 0.00001)
    clearance[i] = Math.floor(Math.min(WALL_CLEARANCE_SCALE, lowerBound) * 255 / WALL_CLEARANCE_SCALE)
  }
  return clearance
}

/** World-space solids stay resolved when the camera zooms out. One byte/texel. */
export function buildSolidMask(layout: FluidLayout, maxTextureSize = 4096) {
  const spanX = layout.maxX - layout.minX
  const spanY = layout.maxY - layout.minY
  const scale = Math.min(32, maxTextureSize / Math.max(spanX, spanY))
  const width = Math.max(1, Math.min(maxTextureSize, Math.ceil(spanX * scale)))
  const height = Math.max(1, Math.min(maxTextureSize, Math.ceil(spanY * scale)))
  const data = new Uint8Array(width * height)
  for (const wall of layout.walls) {
    // Conservative rasterization preserves thin walls at every maze size.
    const x0 = Math.max(0, Math.floor((wall.x0 - layout.minX) / spanX * width))
    const x1 = Math.min(width, Math.ceil((wall.x1 - layout.minX) / spanX * width))
    const y0 = Math.max(0, Math.floor((wall.y0 - layout.minY) / spanY * height))
    const y1 = Math.min(height, Math.ceil((wall.y1 - layout.minY) / spanY * height))
    for (let row = y0; row < y1; row++) data.fill(255, row * width + x0, row * width + x1)
  }
  const clearance = buildWallClearance(data, width, height, Math.min(spanX / width, spanY / height))
  return {
    data, clearance, clearanceScale: WALL_CLEARANCE_SCALE,
    width, height, bounds: [layout.minX, layout.minY, spanX, spanY] as const,
  }
}

export const WATER_WALL_VISIBILITY = /* glsl */ `
  uniform sampler2D uWalls;
  uniform vec4 uWallBounds;
  float wallAt(vec2 point) {
    vec2 uv = (point - uWallBounds.xy) / uWallBounds.zw;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
    return step(0.5, texture2D(uWalls, uv).r);
  }
  // Splat support is bounded to .42 cells; eight samples cannot jump a .1 wall.
  float clearSegment(vec2 from, vec2 to) {
    for (int i = 1; i <= 8; i++) {
      if (wallAt(mix(from, to, float(i) / 8.0)) > 0.5) return 0.0;
    }
    return 1.0;
  }
`
