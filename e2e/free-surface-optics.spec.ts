import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import type * as THREE from 'three'
import { createEmptyGraph } from '../src/core/maze'
import { createTestProject } from '../src/test/projectFixture'
import { buildFluidLayout } from '../src/features/waterSimulation/freeSurface/layout'
import type { FluidSnapshot } from '../src/features/waterSimulation/freeSurface/types'
import type { FreeSurfaceRenderer } from '../src/features/waterSimulation/freeSurface/renderer'

test('water keeps its occupied shape at every speed and clear water remains visible on the pale board', async ({ page }) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/features/waterSimulation/freeSurface/renderer.ts', import.meta.url))],
    bundle: true, platform: 'browser', format: 'iife',
    globalName: 'WaterOpticsFixture', write: false, logLevel: 'silent',
  })
  await page.route('**/__water-optics-fixture.js', route => route.fulfill({
    contentType: 'application/javascript', body: bundle.outputFiles[0].text,
  }))
  await page.goto('/')
  await page.addScriptTag({ url: '/__water-optics-fixture.js' })
  const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(5, 5) }))
  const results = await page.evaluate(input => {
    type Internals = {
      renderer: THREE.WebGLRenderer
      surfaceTarget: THREE.WebGLRenderTarget
      boardTarget: THREE.WebGLRenderTarget
      waterMaterial: THREE.ShaderMaterial
    }
    const { FreeSurfaceRenderer: Renderer } = (window as unknown as {
      WaterOpticsFixture: { FreeSurfaceRenderer: typeof FreeSurfaceRenderer }
    }).WaterOpticsFixture
    const fixtureLayout = { ...input, activeCells: Uint8Array.from(input.activeCells), walls: [] }
    const mount = document.createElement('div')
    mount.style.cssText = 'position:fixed;left:0;top:0;width:280px;height:380px;'
    document.body.appendChild(mount)
    const view = new Renderer(mount, fixtureLayout, 'high')
    const internals = view as unknown as Internals
    const snapshot = (points: number[], speed: number): FluidSnapshot => {
      const count = points.length / 2
      return {
        positions: new Float32Array(points),
        velocities: Float32Array.from(points, (_, index) => index % 2 === 1 ? speed : 0),
        count,
        diagnostics: {
          time: 1, count, injected: count * input.particleArea, stored: count * input.particleArea,
          discharged: 0, escaped: 0, massError: 0, maxVelocity: Math.abs(speed),
          wetCells: count ? 1 : 0, reachedExit: false, outletRate: 0, saturated: false,
        },
      }
    }
    const readField = () => {
      const target = internals.surfaceTarget
      const data = new Uint8Array(target.width * target.height * 4)
      internals.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, data)
      return data
    }
    const fieldPixel = (x: number, y: number) => {
      const target = internals.surfaceTarget
      const center = internals.waterMaterial.uniforms.uCenter.value as THREE.Vector2
      const size = internals.waterMaterial.uniforms.uViewSize.value as THREE.Vector2
      const col = Math.min(target.width - 1, Math.max(0, Math.floor(((x - center.x) / size.x + 0.5) * target.width)))
      const row = Math.min(target.height - 1, Math.max(0, Math.floor(((-y - center.y) / size.y + 0.5) * target.height)))
      return (row * target.width + col) * 4
    }
    const readColor = (mode: 'free-surface' | 'surface-3d') => {
      if (mode === 'surface-3d') {
        const target = internals.boardTarget
        const data = new Uint8Array(target.width * target.height * 4)
        internals.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, data)
        return { data, width: target.width, height: target.height }
      }
      const gl = internals.renderer.getContext()
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight
      const data = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data)
      return { data, width, height }
    }
    try {
      return (['free-surface', 'surface-3d'] as const).map(mode => {
        view.setViewMode(mode)
        view.setAppearance({ profile: 'clear', color: null, opacity: 0.82 })
        const points = [2.35, 2.1, 2.5, 2.1, 2.65, 2.1, 2.35, 2.25, 2.5, 2.25, 2.65, 2.25]
        const fields = [0, 8.9, -8.9].map(speed => { view.render(snapshot(points, speed)); return readField() })
        let differingShapeChannels = 0, movingVelocityPixels = 0, wetPixels = 0
        for (let index = 0; index < fields[0].length; index += 4) {
          if (fields[0][index + 2] > 0) wetPixels++
          for (const field of fields.slice(1)) {
            for (const channel of [0, 2]) if (fields[0][index + channel] !== field[index + channel]) differingShapeChannels++
          }
          if (fields[1][index + 1] !== fields[0][index + 1]) movingVelocityPixels++
        }
        view.render(snapshot([2.5, 2.05, 2.5, 2.45], 8.9))
        const gapCoverage = readField()[fieldPixel(2.5, 2.25) + 2]
        const jet = Array.from({ length: 7 }, (_, i) => [2.5, 1.8 + i * 0.15]).flat()
        view.render(snapshot(jet, 8.9))
        const jetField = readField()
        const bridgeCoverage = Array.from({ length: 6 }, (_, i) => jetField[fieldPixel(2.5, 1.875 + i * 0.15) + 2])

        // Compare the same board coordinates with and without clear water.
        // A broad patch includes the body as well as the reflective boundary.
        const pool = Array.from({ length: 72 }, (_, i) => [1.7 + (i % 9) * 0.15, 1.75 + Math.floor(i / 9) * 0.15]).flat()
        view.render(snapshot([], 0))
        const dry = readColor(mode)
        view.render(snapshot(pool, 0))
        const wet = readColor(mode), poolField = readField()
        const target = internals.surfaceTarget
        let samples = 0, contrasted = 0, difference = 0, chromaShift = 0
        for (let row = 0; row < wet.height; row++) for (let col = 0; col < wet.width; col++) {
          const fieldCol = Math.min(target.width - 1, Math.floor((col + 0.5) * target.width / wet.width))
          const fieldRow = Math.min(target.height - 1, Math.floor((row + 0.5) * target.height / wet.height))
          if (poolField[(fieldRow * target.width + fieldCol) * 4 + 2] < 235) continue
          const index = (row * wet.width + col) * 4
          const delta = [0, 1, 2].map(channel => wet.data[index + channel] - dry.data[index + channel])
          const luminanceDifference = Math.abs(delta[0] * 0.2126 + delta[1] * 0.7152 + delta[2] * 0.0722)
          samples++; difference += luminanceDifference
          if (luminanceDifference >= 8) contrasted++
          chromaShift += Math.max(...delta) - Math.min(...delta)
        }
        const absorption = (internals.waterMaterial.uniforms.uAbsorption.value as THREE.Vector3).toArray()
        const scatter = (internals.waterMaterial.uniforms.uScatter.value as THREE.Vector3).toArray()
        return {
          mode, differingShapeChannels, movingVelocityPixels, wetPixels, gapCoverage, bridgeCoverage,
          samples, meanContrast: difference / samples, visibleFraction: contrasted / samples,
          meanChromaShift: chromaShift / samples, absorption, scatter,
          error: internals.renderer.getContext().getError(),
        }
      })
    } finally {
      view.dispose()
      mount.remove()
    }
  }, { ...layout, activeCells: Array.from(layout.activeCells) })
  await test.info().attach('water-optics-measurements', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
  for (const result of results) {
    expect(result.wetPixels, `${result.mode}: visible fixture`).toBeGreaterThan(10)
    expect(result.differingShapeChannels, `${result.mode}: velocity must not invent occupied water`).toBe(0)
    expect(result.movingVelocityPixels, `${result.mode}: measured speed still reaches lighting`).toBeGreaterThan(10)
    expect(result.gapCoverage, `${result.mode}: disconnected drops remain separate`).toBe(0)
    for (const coverage of result.bridgeCoverage) expect(coverage, `${result.mode}: actual continuous jet stays connected`).toBeGreaterThan(80)
    expect(result.samples, `${result.mode}: broad wet body`).toBeGreaterThan(60)
    expect(result.meanContrast, `${result.mode}: clear body visible against pale backing`).toBeGreaterThanOrEqual(12)
    expect(result.visibleFraction, `${result.mode}: contrast spans the wet body`).toBeGreaterThanOrEqual(0.65)
    expect(result.meanChromaShift, `${result.mode}: neutral optics retain the backing hue`).toBeLessThan(8)
    expect(result.absorption[0]).toBe(result.absorption[1])
    expect(result.absorption[1]).toBe(result.absorption[2])
    expect(result.scatter).toEqual([0, 0, 0])
    expect(result.error).toBe(0)
  }
})
