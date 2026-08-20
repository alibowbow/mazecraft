import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const CONTROLS_INSTALL_FLAG = '__mazeCraftWaterPanControlsInstalled__'
const RENDERER_INSTALL_FLAG = '__mazeCraftWaterPanRendererInstalled__'
const WATER_CANVAS_CLASS = 'water-simulation-canvas'

interface WaterRenderContext {
  renderer: THREE.WebGLRenderer
  scene: THREE.Object3D
  camera: THREE.Camera
}

type AugmentedOrbitControls = OrbitControls & {
  __mazeCraftWaterPanCleanup?: () => void
}

type AugmentedControlsPrototype = typeof OrbitControls.prototype & {
  [CONTROLS_INSTALL_FLAG]?: boolean
}

type AugmentedRendererPrototype = typeof THREE.WebGLRenderer.prototype & {
  [RENDERER_INSTALL_FLAG]?: boolean
}

const renderContextByCanvas = new WeakMap<
  HTMLCanvasElement,
  WaterRenderContext
>()

const originalRendererRender = THREE.WebGLRenderer.prototype.render

function isWaterCanvas(
  element: HTMLElement | null,
): element is HTMLCanvasElement {
  return (
    typeof HTMLCanvasElement !== 'undefined' &&
    element instanceof HTMLCanvasElement &&
    element.classList.contains(WATER_CANVAS_CLASS)
  )
}

function writeCameraTelemetry(controls: OrbitControls): void {
  const canvas = controls.domElement
  if (!isWaterCanvas(canvas)) return
  const target = controls.target
  const cameraPosition = controls.object.position
  canvas.dataset.cameraNavigation = 'pan-zoom'
  canvas.dataset.cameraDrag = 'one-pointer-pan'
  canvas.dataset.cameraPinch = 'dolly-pan'
  canvas.dataset.cameraTargetX = target.x.toFixed(4)
  canvas.dataset.cameraTargetY = target.y.toFixed(4)
  canvas.dataset.cameraTargetZ = target.z.toFixed(4)
  canvas.dataset.cameraDistance = cameraPosition.distanceTo(target).toFixed(4)
}

function schedulePausedCameraRender(
  controls: OrbitControls,
  canvas: HTMLCanvasElement,
): () => void {
  let frameId = 0

  const render = () => {
    writeCameraTelemetry(controls)
    if (!canvas.closest('[data-phase="paused"]')) return
    if (frameId !== 0) return

    const performRender = () => {
      frameId = 0
      const context = renderContextByCanvas.get(canvas)
      if (!context) return
      originalRendererRender.call(
        context.renderer,
        context.scene,
        context.camera,
      )
    }

    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
      frameId = window.requestAnimationFrame(performRender)
    } else {
      performRender()
    }
  }

  controls.addEventListener('change', render)
  return () => {
    controls.removeEventListener('change', render)
    if (
      frameId !== 0 &&
      typeof window !== 'undefined' &&
      window.cancelAnimationFrame
    ) {
      window.cancelAnimationFrame(frameId)
    }
  }
}

/** Re-enables user camera inspection even when the water flow is paused. */
export function activateWaterCameraNavigation(
  controls: OrbitControls,
): boolean {
  if (!isWaterCanvas(controls.domElement)) return false
  if (typeof document === 'undefined' || !document.hidden) {
    controls.enabled = true
    controls.enablePan = true
  }
  return true
}

/**
 * Makes the water-maze camera behave like a movable canvas:
 * one pointer drags the view, and two pointers pinch while panning.
 */
export function configureWaterCameraNavigation(
  controls: OrbitControls,
): boolean {
  const canvas = controls.domElement
  if (!isWaterCanvas(canvas)) return false

  controls.enablePan = true
  controls.screenSpacePanning = true
  controls.panSpeed = 0.9
  controls.zoomToCursor = true
  controls.mouseButtons.LEFT = THREE.MOUSE.PAN
  controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY
  controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
  controls.touches.ONE = THREE.TOUCH.PAN
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN
  canvas.style.touchAction = 'none'
  writeCameraTelemetry(controls)

  const augmented = controls as AugmentedOrbitControls
  if (augmented.__mazeCraftWaterPanCleanup) return true

  const wakeForInput = () => {
    // Capture runs before OrbitControls' own pointer/wheel listener.
    activateWaterCameraNavigation(controls)
  }
  canvas.addEventListener('pointerdown', wakeForInput, { capture: true })
  canvas.addEventListener('wheel', wakeForInput, {
    capture: true,
    passive: true,
  })
  const removePausedRender = schedulePausedCameraRender(controls, canvas)

  augmented.__mazeCraftWaterPanCleanup = () => {
    canvas.removeEventListener('pointerdown', wakeForInput, { capture: true })
    canvas.removeEventListener('wheel', wakeForInput, { capture: true })
    removePausedRender()
    delete augmented.__mazeCraftWaterPanCleanup
  }
  return true
}

function installRendererTracking(): void {
  const prototype =
    THREE.WebGLRenderer.prototype as AugmentedRendererPrototype
  if (prototype[RENDERER_INSTALL_FLAG]) return
  prototype[RENDERER_INSTALL_FLAG] = true

  prototype.render = function renderWaterCameraFrame(
    this: THREE.WebGLRenderer,
    scene: THREE.Object3D,
    camera: THREE.Camera,
  ): void {
    if (isWaterCanvas(this.domElement)) {
      renderContextByCanvas.set(this.domElement, {
        renderer: this,
        scene,
        camera,
      })
    }
    originalRendererRender.call(this, scene, camera)
  }
}

function installControlsEnhancer(): void {
  const prototype =
    OrbitControls.prototype as AugmentedControlsPrototype
  if (prototype[CONTROLS_INSTALL_FLAG]) return
  prototype[CONTROLS_INSTALL_FLAG] = true

  const originalUpdate = prototype.update
  const originalDispose = prototype.dispose

  prototype.update = function updateWaterCameraNavigation(
    this: OrbitControls,
    deltaTime?: number,
  ): boolean {
    const configured = configureWaterCameraNavigation(this)
    const changed = originalUpdate.call(this, deltaTime)
    if (configured) writeCameraTelemetry(this)
    return changed
  }

  prototype.dispose = function disposeWaterCameraNavigation(
    this: OrbitControls,
  ): void {
    const augmented = this as AugmentedOrbitControls
    augmented.__mazeCraftWaterPanCleanup?.()
    originalDispose.call(this)
  }
}

installRendererTracking()
installControlsEnhancer()
