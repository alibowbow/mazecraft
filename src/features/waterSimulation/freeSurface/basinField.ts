import * as THREE from 'three'
import type { BasinSnapshot } from './basinSimulation'

/** One texel per control volume. Static portal bits travel with actual depth. */
export class BasinField {
  readonly texture: THREE.DataTexture
  readonly size: THREE.Vector2
  private readonly data: Float32Array
  constructor(readonly rows: number, readonly cols: number) {
    this.data = new Float32Array(rows * cols * 4)
    this.texture = new THREE.DataTexture(this.data, cols, rows, THREE.RGBAFormat, THREE.FloatType)
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter
    this.texture.needsUpdate = true
    this.size = new THREE.Vector2(cols, rows)
  }
  update(snapshot: BasinSnapshot): void {
    if (snapshot.rows !== this.rows || snapshot.cols !== this.cols) throw new RangeError('Basin field dimensions changed.')
    for (let cell = 0; cell < snapshot.depth.length; cell++) {
      this.data[cell * 4] = snapshot.depth[cell]
      this.data[cell * 4 + 1] = snapshot.velocity[cell * 2]
      this.data[cell * 4 + 2] = snapshot.velocity[cell * 2 + 1]
      this.data[cell * 4 + 3] = snapshot.connections[cell] === 255 ? 0 : 16 + snapshot.connections[cell]
    }
    this.texture.needsUpdate = true
  }
  dispose(): void { this.texture.dispose() }
}

/** Manual interpolation never borrows depth through a closed ceramic wall. */
export const BASIN_FIELD_GLSL = /* glsl */ `
  uniform sampler2D uBasin;
  uniform vec2 uBasinSize;
  uniform float uBasinEnabled;
  vec4 rawBasinCell(vec2 cell) {
    if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, uBasinSize))) return vec4(0.0);
    return texture2D(uBasin, (cell + 0.5) / uBasinSize);
  }
  float basinPortal(float code, float bit) {
    return step(0.5, mod(floor(max(0.0, code - 16.0) / bit), 2.0)) * step(15.5, code);
  }
  vec4 basinAt(vec2 world) {
    vec2 maze = vec2(world.x, -world.y), cell = floor(maze);
    vec4 center = rawBasinCell(cell);
    if (center.a < 15.5) return vec4(0.0);
    vec2 offset = maze - cell - 0.5;
    vec2 direction = step(vec2(0.0), offset) * 2.0 - 1.0;
    float xBit = direction.x > 0.0 ? 1.0 : 4.0;
    float yBit = direction.y > 0.0 ? 2.0 : 8.0;
    float openX = basinPortal(center.a, xBit), openY = basinPortal(center.a, yBit);
    vec4 alongX = rawBasinCell(cell + vec2(direction.x, 0.0));
    vec4 alongY = rawBasinCell(cell + vec2(0.0, direction.y));
    float openDiagonal = max(openX * basinPortal(alongX.a, yBit), openY * basinPortal(alongY.a, xBit));
    vec4 diagonal = mix(center, rawBasinCell(cell + direction), openDiagonal);
    alongX = mix(center, alongX, openX);
    alongY = mix(center, alongY, openY);
    vec4 water = mix(mix(center, alongX, abs(offset.x)), mix(alongY, diagonal, abs(offset.x)), abs(offset.y));
    // Wetness belongs to this actual control volume, never to its neighbor.
    water.a = step(0.002, center.r);
    return water;
  }
`
