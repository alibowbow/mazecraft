import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import type * as THREE from 'three'
import { createEmptyGraph } from '../src/core/maze'
import { createTestProject } from '../src/test/projectFixture'
import { buildFluidLayout } from '../src/features/waterSimulation/freeSurface/layout'
import type { FluidSnapshot } from '../src/features/waterSimulation/freeSurface/types'
import type { FreeSurfaceRenderer } from '../src/features/waterSimulation/freeSurface/renderer'

test('water filter cropping preserves every wet texel above and below a canvas pixel ratio of one', async ({ page }) => {
  // Run the actual renderer, including its Three.js integration, in the browser.
  // A same-origin in-memory bundle also works against the production preview,
  // which intentionally does not expose TypeScript source paths.
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/features/waterSimulation/freeSurface/renderer.ts', import.meta.url))],
    bundle: true, platform: 'browser', format: 'iife',
    globalName: 'WaterRendererFixture', write: false, logLevel: 'silent',
  })
  await page.route('**/__water-renderer-fixture.js', route => route.fulfill({
    contentType: 'application/javascript', body: bundle.outputFiles[0].text,
  }))
  await page.goto('/')
  await page.addScriptTag({ url: '/__water-renderer-fixture.js' })
  const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(5, 5) }))
  const results = await page.evaluate((input) => {
    type Internals = {
      renderer: THREE.WebGLRenderer
      surfaceTarget: THREE.WebGLRenderTarget
      filterScene: THREE.Scene
      camera: THREE.Camera
      filterSurface(target: THREE.WebGLRenderTarget): void
    }
    const { FreeSurfaceRenderer: Renderer } = (window as unknown as {
      WaterRendererFixture: { FreeSurfaceRenderer: typeof FreeSurfaceRenderer }
    }).WaterRendererFixture
    const fixtureLayout = { ...input, activeCells: Uint8Array.from(input.activeCells), walls: [] }
    const snapshot: FluidSnapshot = {
      positions: new Float32Array([1.15, 1.1, 1.34, 1.13, 2.65, 2.4, 2.81, 2.43]),
      velocities: new Float32Array([1.5, 1.8, 0, 3, 0, 0, -1, 2]),
      count: 4,
      diagnostics: {
        time: 1, count: 4, injected: input.particleArea * 4,
        stored: input.particleArea * 4, discharged: 0, escaped: 0,
        massError: 0, maxVelocity: 3, wetCells: 2, reachedExit: false,
        outletRate: 0, saturated: false,
      },
    }
    return [1.5, 0.75].map(pixelRatio => {
      const mount = document.createElement('div')
      mount.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:240px;'
      document.body.appendChild(mount)
      const view = new Renderer(mount, fixtureLayout, 'high')
      const internals = view as unknown as Internals
      try {
        // Render-target texel coordinates are independent of the canvas DPR.
        // Both >1 mobile DPR and <1 large-canvas budgets must preserve them.
        internals.renderer.setPixelRatio(pixelRatio)
        view.render(snapshot)
        const target = internals.surfaceTarget
        const cropped = new Uint8Array(target.width * target.height * 4)
        internals.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, cropped)
        const croppedArea = target.scissor.z * target.scissor.w

        // Reference: execute the same live filter shaders over the entire
        // target, with no cropping API or independently reimplemented math.
        internals.filterSurface = function (filterTarget) {
          filterTarget.scissorTest = false
          this.renderer.setRenderTarget(filterTarget)
          this.renderer.setScissorTest(false)
          this.renderer.autoClear = true
          this.renderer.render(this.filterScene, this.camera)
        }
        view.render(snapshot)
        const full = new Uint8Array(cropped.length)
        internals.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, full)
        let differingChannels = 0, wetPixels = 0
        for (let index = 0; index < full.length; index += 4) {
          if (full[index + 2] > 0) wetPixels++
          // Alpha is unused scratch storage; all consumed density, velocity
          // and coverage channels must be bit-identical, including dry pixels.
          for (let channel = 0; channel < 3; channel++) {
            if (cropped[index + channel] !== full[index + channel]) differingChannels++
          }
        }
        return {
          pixelRatio: internals.renderer.getPixelRatio(), differingChannels, wetPixels,
          croppedArea, targetArea: target.width * target.height,
          error: internals.renderer.getContext().getError(),
        }
      } finally {
        view.dispose()
        mount.remove()
      }
    })
  }, { ...layout, activeCells: Array.from(layout.activeCells) })
  for (const result of results) {
    expect(result.pixelRatio).not.toBe(1)
    expect(result.croppedArea).toBeGreaterThan(0)
    expect(result.croppedArea).toBeLessThan(result.targetArea)
    expect(result.wetPixels).toBeGreaterThan(20)
    expect(result.differingChannels, `canvas DPR ${result.pixelRatio}`).toBe(0)
    expect(result.error).toBe(0)
  }
})
