import * as THREE from 'three'

export const INITIAL_SURFACE_YAW = 0.24
export const INITIAL_SURFACE_PITCH = 0.18

/** A direct-grab virtual trackball; no Euler limits or pole singularities. */
export class SurfaceTrackball {
  readonly orientation = new THREE.Quaternion()
  private readonly from = new THREE.Vector3()
  private readonly to = new THREE.Vector3()
  private readonly rotation = new THREE.Quaternion()

  constructor() {
    this.reset()
  }

  reset(): void {
    this.orientation.setFromEuler(new THREE.Euler(-INITIAL_SURFACE_PITCH, INITIAL_SURFACE_YAW, 0, 'YXZ'))
  }

  rotate(fromX: number, fromY: number, toX: number, toY: number, width: number, height: number): void {
    if (![fromX, fromY, toX, toY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return
    this.project(fromX, fromY, width, height, this.from)
    this.project(toX, toY, width, height, this.to)
    // The board follows the finger. The camera therefore receives the inverse
    // of the grabbed surface's rotation, in its own current screen axes.
    this.rotation.setFromUnitVectors(this.to, this.from)
    this.orientation.multiply(this.rotation).normalize()
  }

  private project(x: number, y: number, width: number, height: number, result: THREE.Vector3): void {
    const radius = Math.max(1, Math.min(width, height) * 0.45)
    const nx = (x - width * 0.5) / radius
    const ny = (height * 0.5 - y) / radius
    const distanceSquared = nx * nx + ny * ny
    // A hyperbolic continuation keeps edge/outside drags continuous instead of
    // locking the trackball to a flat rim or flipping at the sphere boundary.
    const z = distanceSquared <= 0.5
      ? Math.sqrt(1 - distanceSquared)
      : 0.5 / Math.sqrt(distanceSquared)
    result.set(nx, ny, z).normalize()
  }
}
