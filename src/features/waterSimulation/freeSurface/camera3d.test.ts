import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createEmptyGraph } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { buildFluidLayout } from './layout'
import { SurfaceTrackball } from './camera3d'
import { FreeSurfacePresentation3D } from './presentation3d'

function presentation() {
  const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(6, 6) }))
  return new FreeSurfacePresentation3D(layout, new THREE.Texture())
}

describe('direct-grab 3D water camera', () => {
  it.each([
    { yaw: 0.24, pitch: -0.18, roll: 0 },
    { yaw: Math.PI, pitch: 0.7, roll: 0.6 },
    { yaw: -1.8, pitch: 2.4, roll: -1.1 },
  ])('moves a grabbed frontmost point in the finger direction from $yaw radians', angles => {
    const board = presentation()
    const trackball = new SurfaceTrackball()
    const original = new THREE.Quaternion().setFromEuler(new THREE.Euler(angles.pitch, angles.yaw, angles.roll))
    for (const [dx, dy] of [[95, 0], [-95, 0], [0, 75], [0, -75]]) {
      trackball.orientation.copy(original)
      board.updateView(800, 600, 1, 0, 0, trackball.orientation)
      const grabbedPoint = board.target.clone().addScaledVector(board.viewDirection, 2)
      const before = grabbedPoint.clone().project(board.camera)
      trackball.rotate(400, 300, 400 + dx, 300 + dy, 800, 600)
      board.updateView(800, 600, 1, 0, 0, trackball.orientation)
      const after = grabbedPoint.clone().project(board.camera)
      const screenX = (after.x - before.x) * 400
      const screenY = -(after.y - before.y) * 300
      if (dx) {
        expect(screenX * Math.sign(dx)).toBeGreaterThan(5)
        expect(Math.abs(screenY)).toBeLessThan(1e-8)
      } else {
        expect(screenY * Math.sign(dy)).toBeGreaterThan(5)
        expect(Math.abs(screenX)).toBeLessThan(1e-8)
      }
    }
    board.dispose()
  })

  it('orbits beyond the back and both poles without changing fit or losing a valid camera', () => {
    const board = presentation()
    const trackball = new SurfaceTrackball()
    board.updateView(900, 600, 1, 0, 0, trackball.orientation)
    const fit = board.viewSize.clone()
    let sawBack = false
    let sawUpsideDown = false
    for (let i = 0; i < 64; i++) {
      const horizontal = i < 32
      trackball.rotate(450, 300, horizontal ? 660 : 450, horizontal ? 300 : 510, 900, 600)
      board.updateView(900, 600, 1, 0, 0, trackball.orientation)
      sawBack ||= board.viewDirection.z < -0.7
      sawUpsideDown ||= board.camera.up.y < -0.7
      expect(board.viewSize.equals(fit)).toBe(true)
      expect(trackball.orientation.length()).toBeCloseTo(1, 12)
      expect(board.camera.matrixWorld.elements.every(Number.isFinite)).toBe(true)
      expect(board.viewDirection.distanceTo(new THREE.Vector3(0, 0, 1).applyQuaternion(board.camera.quaternion))).toBeLessThan(1e-12)
    }
    expect(sawBack).toBe(true)
    expect(sawUpsideDown).toBe(true)
    board.dispose()
  })

  it.each([0.2, Math.PI, -1.9])('pans by exact screen pixels after orbiting to $0 radians', yaw => {
    const board = presentation()
    const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, yaw, -0.6))
    board.updateView(900, 600, 1.7, 0, 0, orientation)
    const point = board.target.clone()
    const before = point.clone().project(board.camera)
    board.updateView(900, 600, 1.7, -80 * board.viewSize.x / 900, 45 * board.viewSize.y / 600, orientation)
    const after = point.clone().project(board.camera)
    expect((after.x - before.x) * 450).toBeCloseTo(80, 10)
    expect(-(after.y - before.y) * 300).toBeCloseTo(45, 10)
    board.dispose()
  })
})
