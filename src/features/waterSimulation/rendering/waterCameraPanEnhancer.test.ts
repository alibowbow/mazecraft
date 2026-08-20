import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activateWaterCameraNavigation,
  configureWaterCameraNavigation,
} from './waterCameraPanEnhancer'

function createControls(waterCanvas = true) {
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
  camera.position.set(0, 0, 12)
  const canvas = document.createElement('canvas')
  if (waterCanvas) canvas.className = 'water-simulation-canvas'
  document.body.append(canvas)
  const controls = new OrbitControls(camera, canvas)
  return { camera, canvas, controls }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('water camera navigation enhancer', () => {
  it('maps one-pointer drag to pan and two-pointer gestures to dolly-pan', () => {
    const { canvas, controls } = createControls()
    controls.enablePan = false

    controls.update()

    expect(controls.enablePan).toBe(true)
    expect(controls.screenSpacePanning).toBe(true)
    expect(controls.zoomToCursor).toBe(true)
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.PAN)
    expect(controls.mouseButtons.MIDDLE).toBe(THREE.MOUSE.DOLLY)
    expect(controls.mouseButtons.RIGHT).toBe(THREE.MOUSE.ROTATE)
    expect(controls.touches.ONE).toBe(THREE.TOUCH.PAN)
    expect(controls.touches.TWO).toBe(THREE.TOUCH.DOLLY_PAN)
    expect(canvas.style.touchAction).toBe('none')
    expect(canvas.dataset.cameraNavigation).toBe('pan-zoom')
    expect(canvas.dataset.cameraDrag).toBe('one-pointer-pan')
    expect(canvas.dataset.cameraPinch).toBe('dolly-pan')

    controls.dispose()
  })

  it('re-enables camera inspection input while the water simulation is paused', () => {
    const { controls } = createControls()
    controls.enabled = false
    controls.enablePan = false

    expect(activateWaterCameraNavigation(controls)).toBe(true)
    expect(controls.enabled).toBe(true)
    expect(controls.enablePan).toBe(true)

    controls.dispose()
  })

  it('does not alter OrbitControls attached to unrelated canvases', () => {
    const { controls } = createControls(false)
    controls.enablePan = false

    expect(configureWaterCameraNavigation(controls)).toBe(false)
    expect(activateWaterCameraNavigation(controls)).toBe(false)
    expect(controls.enablePan).toBe(false)

    controls.dispose()
  })
})
