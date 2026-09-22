import { visitProjectLibrary } from './helpers/navigation'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import type * as THREE from 'three'
import { createEmptyGraph } from '../src/core/maze'
import { createTestProject } from '../src/test/projectFixture'
import { buildFluidLayout } from '../src/features/waterSimulation/freeSurface/layout'
import { createTerraceElevation, terraceElevationAt } from '../src/features/waterSimulation/freeSurface/terraceElevation'
import type { FluidSnapshot } from '../src/features/waterSimulation/freeSurface/types'
import type { FreeSurfaceRenderer } from '../src/features/waterSimulation/freeSurface/renderer'
import type { BasinSimulation, BasinSnapshot } from '../src/features/waterSimulation/freeSurface/basinSimulation'
import { BASIN_FLOOR_Z, BASIN_INITIAL_DEPTH } from '../src/features/waterSimulation/freeSurface/basinSimulation'

test('2D water keeps its occupied shape at every speed and clear water remains visible on the pale board', async ({ page }) => {
  test.setTimeout(120_000)
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/features/waterSimulation/freeSurface/renderer.ts', import.meta.url))],
    bundle: true, platform: 'browser', format: 'iife',
    globalName: 'WaterOpticsFixture', write: false, logLevel: 'silent',
  })
  await page.route('**/__water-optics-fixture.js', route => route.fulfill({
    contentType: 'application/javascript', body: bundle.outputFiles[0].text,
  }))
  await visitProjectLibrary(page)
  await page.addScriptTag({ url: '/__water-optics-fixture.js' })
  const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(5, 5) }))
  const poolFixture = { minX: 1.7, minY: 3.25, cols: 9, rows: 8, spacing: 0.15, inset: 0.20, settledWaterZ: 0.118 }
  const terraces = createTerraceElevation(layout)
  // The complete pool, including particle support, sits on the lower plateau.
  // Its core is farther from the shoreline than the height-field mip radius,
  // so still water there has the shader's exact full-coverage height .018+.10.
  expect(terraceElevationAt(terraces, -(poolFixture.minY - 0.42))).toBe(0)
  expect(terraceElevationAt(terraces, -(poolFixture.minY + (poolFixture.rows - 1) * poolFixture.spacing + 0.42))).toBe(0)
  const results = await page.evaluate(({ layout: input, poolFixture }) => {
    type Internals = {
      renderer: THREE.WebGLRenderer
      surfaceTarget: THREE.WebGLRenderTarget
      presentation3d: { camera: THREE.OrthographicCamera }
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
    const readColor = () => {
      const gl = internals.renderer.getContext()
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight
      const data = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data)
      return { data, width, height }
    }
    try {
      const modes: Array<'free-surface' | 'surface-3d'> = ['free-surface']
      return modes.map(mode => {
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

        // Sample settled water wholly inside the lowest terrace. Intersect
        // pixels with the actual liquid plane, not z=0: elevated water projects
        // to different screen coordinates from the ceramic underneath it.
        const pool = Array.from({ length: poolFixture.cols * poolFixture.rows }, (_, i) => [
          poolFixture.minX + (i % poolFixture.cols) * poolFixture.spacing,
          poolFixture.minY + Math.floor(i / poolFixture.cols) * poolFixture.spacing,
        ]).flat()
        view.render(snapshot([], 0))
        const dry = readColor()
        view.render(snapshot(pool, 0))
        const wet = readColor(), poolField = readField()
        const target = internals.surfaceTarget
        const eye = mode === 'surface-3d' ? internals.presentation3d.camera : null
        const ray = eye?.getWorldDirection(eye.position.clone())
        const fieldCenter = internals.waterMaterial.uniforms.uCenter.value as THREE.Vector2
        const fieldSize = internals.waterMaterial.uniforms.uViewSize.value as THREE.Vector2
        let samples = 0, contrasted = 0, difference = 0, chromaShift = 0
        for (let row = 0; row < wet.height; row++) for (let col = 0; col < wet.width; col++) {
          let u = (col + 0.5) / wet.width, v = (row + 0.5) / wet.height
          if (eye && ray) {
            const point = eye.position.clone().set(u * 2 - 1, v * 2 - 1, 0).unproject(eye)
            point.addScaledVector(ray, (poolFixture.settledWaterZ - point.z) / ray.z)
            u = (point.x - fieldCenter.x) / fieldSize.x + 0.5
            v = (point.y - fieldCenter.y) / fieldSize.y + 0.5
          }
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue
          const mazeX = fieldCenter.x + (u - 0.5) * fieldSize.x
          const mazeY = -(fieldCenter.y + (v - 0.5) * fieldSize.y)
          if (mazeX < poolFixture.minX + poolFixture.inset
            || mazeX > poolFixture.minX + (poolFixture.cols - 1) * poolFixture.spacing - poolFixture.inset
            || mazeY < poolFixture.minY + poolFixture.inset
            || mazeY > poolFixture.minY + (poolFixture.rows - 1) * poolFixture.spacing - poolFixture.inset) continue
          const fieldCol = Math.floor(u * target.width), fieldRow = Math.floor(v * target.height)
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
          samples, sampledWaterZ: eye ? poolFixture.settledWaterZ : null,
          meanContrast: difference / samples, visibleFraction: contrasted / samples,
          meanChromaShift: chromaShift / samples, absorption, scatter,
          error: internals.renderer.getContext().getError(),
        }
      })
    } finally {
      view.dispose()
      mount.remove()
    }
  }, { layout: { ...layout, activeCells: Array.from(layout.activeCells) }, poolFixture })
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

test('3D clear basin water uses actual conserved depth and remains visible without a particle footprint', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && /THREE|shader|WebGL|GL_INVALID/i.test(message.text())) errors.push(message.text())
  })
  const bundle = await build({
    stdin: {
      contents: `export { FreeSurfaceRenderer } from './src/features/waterSimulation/freeSurface/renderer';
        export { BasinSimulation, BASIN_FLOOR_Z, BASIN_INITIAL_DEPTH } from './src/features/waterSimulation/freeSurface/basinSimulation';`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'basin-optics-fixture.ts', loader: 'ts',
    },
    bundle: true, platform: 'browser', format: 'iife',
    globalName: 'BasinOpticsFixture', write: false, logLevel: 'silent',
  })
  await page.route('**/__basin-optics-fixture.js', route => route.fulfill({
    contentType: 'application/javascript', body: bundle.outputFiles[0].text,
  }))
  await visitProjectLibrary(page)
  await page.addScriptTag({ url: '/__basin-optics-fixture.js' })
  // One connected, flat vessel provides a broad water core without wall
  // occlusion. Its topology and conserved initial volume are real solver data.
  const graph = createEmptyGraph(5, 5)
  for (const cell of graph.cells) {
    cell.walls = { top: cell.row === 0, right: cell.col === 4, bottom: cell.row === 4, left: cell.col === 0 }
  }
  const project = createTestProject({ mazeGraph: graph })
  const layout = buildFluidLayout(project)
  const result = await page.evaluate(({ project, layout: input }) => {
    const fixture = (window as unknown as {
      BasinOpticsFixture: {
        FreeSurfaceRenderer: typeof FreeSurfaceRenderer
        BasinSimulation: typeof BasinSimulation
        BASIN_FLOOR_Z: number
        BASIN_INITIAL_DEPTH: number
      }
    }).BasinOpticsFixture
    const fixtureLayout = { ...input, activeCells: Uint8Array.from(input.activeCells) }
    const mount = document.createElement('div')
    mount.style.cssText = 'position:fixed;left:0;top:0;width:360px;height:440px;'
    document.body.appendChild(mount)
    const view = new fixture.FreeSurfaceRenderer(mount, fixtureLayout, 'high')
    const solver = new fixture.BasinSimulation(project, fixtureLayout)
    const filled = solver.snapshot()
    const drySnapshot: BasinSnapshot = {
      ...filled, depth: new Float32Array(filled.depth.length), velocity: new Float32Array(filled.velocity.length),
      diagnostics: { ...filled.diagnostics, wetCells: 0, stored: 0 },
    }
    const internals = view as unknown as {
      renderer: THREE.WebGLRenderer
      particleGeometry: THREE.InstancedBufferGeometry
      presentation3d: { camera: THREE.OrthographicCamera; sculpted: { waterMaterial: THREE.MeshPhysicalMaterial } }
    }
    const readColor = () => {
      const gl = internals.renderer.getContext()
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight
      const data = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data)
      return { data, width, height }
    }
    try {
      view.setBasinSnapshot(filled)
      view.setViewMode('surface-3d')
      view.setInflow(false)
      view.setAppearance({ profile: 'clear', color: null, opacity: 0.82 })
      view.setBasinSnapshot(drySnapshot)
      const dry = readColor()
      view.setBasinSnapshot(filled)
      const wet = readColor()
      const eye = internals.presentation3d.camera
      const direction = eye.getWorldDirection(eye.position.clone())
      const waterZ = fixture.BASIN_FLOOR_Z + fixture.BASIN_INITIAL_DEPTH
      let samples = 0, contrasted = 0, difference = 0, chromaShift = 0
      for (let row = 0; row < wet.height; row++) for (let col = 0; col < wet.width; col++) {
        const point = eye.position.clone().set((col + 0.5) / wet.width * 2 - 1, (row + 0.5) / wet.height * 2 - 1, 0).unproject(eye)
        point.addScaledVector(direction, (waterZ - point.z) / direction.z)
        // Test the liquid's interior, not its meniscus or exterior walls.
        if (point.x < 1.5 || point.x > 3.5 || point.y < -3.5 || point.y > -1.5) continue
        const index = (row * wet.width + col) * 4
        const delta = [0, 1, 2].map(channel => wet.data[index + channel] - dry.data[index + channel])
        const contrast = Math.abs(delta[0] * 0.2126 + delta[1] * 0.7152 + delta[2] * 0.0722)
        samples++; difference += contrast
        if (contrast >= 8) contrasted++
        chromaShift += Math.max(...delta) - Math.min(...delta)
      }
      const material = internals.presentation3d.sculpted.waterMaterial
      return {
        samples, sampledWaterZ: waterZ,
        meanContrast: difference / samples, visibleFraction: contrasted / samples, meanChromaShift: chromaShift / samples,
        attenuationColor: material.attenuationColor.toArray(), materialColor: material.color.toArray(),
        storedVolume: filled.diagnostics.stored, initialStoredVolume: filled.initialStoredVolume,
        massError: filled.diagnostics.massError, wetCells: filled.diagnostics.wetCells,
        minDepth: Math.min(...filled.depth), maxDepth: Math.max(...filled.depth),
        particles: internals.particleGeometry.instanceCount,
        model: view.canvas.dataset.waterModel, error: internals.renderer.getContext().getError(),
      }
    } finally {
      view.dispose(); mount.remove()
    }
  }, { project, layout: { ...layout, activeCells: Array.from(layout.activeCells) } })
  await test.info().attach('basin-optics-measurements', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  expect(result.model).toBe('hydraulic-basin')
  expect(result.particles).toBe(0)
  expect(result.wetCells).toBe(25)
  expect(result.storedVolume).toBeCloseTo(result.initialStoredVolume, 10)
  expect(result.massError).toBeLessThan(1e-8)
  expect(result.minDepth).toBeCloseTo(BASIN_INITIAL_DEPTH, 6)
  expect(result.maxDepth).toBeCloseTo(BASIN_INITIAL_DEPTH, 6)
  expect(result.sampledWaterZ).toBeCloseTo(BASIN_FLOOR_Z + BASIN_INITIAL_DEPTH, 6)
  expect(result.samples, 'broad interior on the actual liquid plane').toBeGreaterThan(60)
  expect(result.meanContrast, 'clear water is visible against pale ceramic').toBeGreaterThanOrEqual(12)
  expect(result.visibleFraction, 'contrast spans the wet body').toBeGreaterThanOrEqual(0.65)
  expect(result.meanChromaShift, 'clear water retains the neutral backing hue').toBeLessThan(8)
  expect(result.attenuationColor[0]).toBe(result.attenuationColor[1])
  expect(result.attenuationColor[1]).toBe(result.attenuationColor[2])
  expect(result.materialColor).toEqual([1, 1, 1])
  expect(result.error).toBe(0)
  expect(errors).toEqual([])
})
