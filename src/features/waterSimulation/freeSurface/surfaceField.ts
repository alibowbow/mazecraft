import type { FluidLayout } from './types'

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
  return { data, width, height, bounds: [layout.minX, layout.minY, spanX, spanY] as const }
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
