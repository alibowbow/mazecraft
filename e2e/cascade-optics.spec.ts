import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type * as THREE from 'three'
import { visitProjectLibrary } from './helpers/navigation'
import type { createWaterStudioProject } from '../src/features/waterStudio/presets'
import type { buildFluidLayout } from '../src/features/waterSimulation/freeSurface/layout'
import type { FreeSurfaceRenderer } from '../src/features/waterSimulation/freeSurface/renderer'
import type { CascadeSimulation } from '../src/features/waterSimulation/freeSurface/cascadeSimulation'
import type { createCascadeSurfaces } from '../src/features/waterSimulation/freeSurface/cascadeGeometry'

test('cascade optics isolates water reflections, floor caustics, sun shadows and porcelain materials at one frozen time', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && /THREE|shader|WebGL|GL_INVALID/i.test(message.text())) errors.push(message.text())
  })
  const bundle = await build({
    stdin: {
      contents: `export { FreeSurfaceRenderer } from './src/features/waterSimulation/freeSurface/renderer';
        export { CascadeSimulation } from './src/features/waterSimulation/freeSurface/cascadeSimulation';
        export { createCascadeSurfaces } from './src/features/waterSimulation/freeSurface/cascadeGeometry';
        export { buildFluidLayout } from './src/features/waterSimulation/freeSurface/layout';
        export { createWaterStudioProject } from './src/features/waterStudio/presets';
        export { MeshBasicMaterial } from 'three';`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'cascade-optics-fixture.ts', loader: 'ts',
    },
    bundle: true, platform: 'browser', format: 'iife',
    globalName: 'CascadeOpticsFixture', write: false, logLevel: 'silent',
  })
  await page.route('**/__cascade-optics-fixture.js', route => route.fulfill({
    contentType: 'application/javascript', body: bundle.outputFiles[0].text,
  }))
  // This route has no running simulation competing with the diagnostic scene.
  await visitProjectLibrary(page)
  await page.addScriptTag({ url: '/__cascade-optics-fixture.js' })
  const result = await page.evaluate(() => {
    const fixture = (window as unknown as {
      CascadeOpticsFixture: {
        FreeSurfaceRenderer: typeof FreeSurfaceRenderer
        CascadeSimulation: typeof CascadeSimulation
        createCascadeSurfaces: typeof createCascadeSurfaces
        buildFluidLayout: typeof buildFluidLayout
        createWaterStudioProject: typeof createWaterStudioProject
        MeshBasicMaterial: typeof THREE.MeshBasicMaterial
      }
    }).CascadeOpticsFixture
    const layout = fixture.buildFluidLayout(fixture.createWaterStudioProject('atelier', 'atelier-01'))
    const areas = fixture.createCascadeSurfaces().map(surface => surface.area) as [number, number, number]
    const simulation = new fixture.CascadeSimulation(layout, areas)
    for (let frame = 0; frame < 8; frame++) simulation.advance(0.25, 0.65)
    const snapshot = simulation.snapshot()
    const mount = document.createElement('div')
    mount.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:640px;z-index:2147483647;'
    document.body.appendChild(mount)
    const view = new fixture.FreeSurfaceRenderer(mount, layout, 'high', 'terraced-fountain')
    const internals = view as unknown as {
      renderer: THREE.WebGLRenderer
      presentation3d: {
        scene: THREE.Scene
        sun: THREE.DirectionalLight
        materials: {
          porcelain: THREE.MeshPhysicalMaterial
          water: THREE.MeshPhysicalMaterial
          floors: THREE.MeshPhysicalMaterial[]
        }
      }
    }
    let baselinePixels: Uint8Array | null = null
    const capture = (name: string) => {
      // All six renders use the same hydraulic snapshot. Read pixels and
      // encode the canvas synchronously, before the browser discards its buffer.
      view.setBasinSnapshot(snapshot)
      const gl = internals.renderer.getContext()
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight
      const pixels = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      const image = view.canvas.toDataURL('image/png')
      let changedPixels = 0, totalDifference = 0, minChannel = 255, maxChannel = 0
      for (let index = 0; index < pixels.length; index += 4) {
        let changed = false
        for (let channel = 0; channel < 3; channel++) {
          const value = pixels[index + channel]
          minChannel = Math.min(minChannel, value); maxChannel = Math.max(maxChannel, value)
          if (baselinePixels) {
            const difference = Math.abs(value - baselinePixels[index + channel])
            changed ||= difference > 0
            totalDifference += difference
          }
        }
        if (changed) changedPixels++
      }
      baselinePixels ??= pixels
      return {
        name, image, width, height, error: gl.getError(), changedPixels,
        meanDifference: totalDifference / (width * height * 3), colorRange: maxChannel - minChannel,
      }
    }
    try {
      view.setBasinSnapshot(snapshot)
      view.setViewMode('surface-3d')
      view.setLook({ theme: 'porcelain', light: 'daylight', wallHeight: 1 })
      view.setAppearance({ profile: 'aqua', color: '#16aeb7', opacity: 0.72 })
      view.setSurfaceStyle('natural')
      const presentation = internals.presentation3d

      // Include the cloned waterfall materials as well as the main surface,
      // so water-reflections-off has no leftover reflected waterfall stripes.
      const liquids = new Set<THREE.MeshPhysicalMaterial>([presentation.materials.water])
      const solids = new Set([presentation.materials.porcelain, ...presentation.materials.floors])
      const solidMeshes: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = []
      presentation.scene.traverse(object => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        if (materials.some(material => solids.has(material as THREE.MeshPhysicalMaterial))) {
          solidMeshes.push({ mesh, material: mesh.material })
        }
        for (const material of materials) {
          const physical = material as THREE.MeshPhysicalMaterial
          if (physical.isMeshPhysicalMaterial && physical.transmission > 0) liquids.add(physical)
        }
      })
      const reflections = [...liquids].map(material => ({ material, intensity: material.envMapIntensity }))
      const floors = presentation.materials.floors.map(material => ({
        material, compile: material.onBeforeCompile, cacheKey: material.customProgramCacheKey,
      }))
      const solidOptics = [...solids].map(material => ({
        material, clearcoat: material.clearcoat, intensity: material.envMapIntensity,
      }))
      const castShadow = presentation.sun.castShadow
      const basic = new fixture.MeshBasicMaterial({
        color: 0xf7f5f0,
        side: presentation.materials.porcelain.side,
        shadowSide: presentation.materials.porcelain.shadowSide,
      })
      const restoreBaseline = () => {
        for (const { material, intensity } of reflections) material.envMapIntensity = intensity
        for (const { material, compile, cacheKey } of floors) {
          material.onBeforeCompile = compile; material.customProgramCacheKey = cacheKey
          material.needsUpdate = true
        }
        for (const { material, clearcoat, intensity } of solidOptics) {
          material.clearcoat = clearcoat; material.envMapIntensity = intensity
          material.needsUpdate = true
        }
        for (const { mesh, material } of solidMeshes) mesh.material = material
        presentation.sun.castShadow = castShadow
        internals.renderer.shadowMap.needsUpdate = true
      }
      const frames = [capture('cascade-optics-baseline')]

      for (const { material } of reflections) material.envMapIntensity = 0
      frames.push(capture('cascade-optics-water-reflections-off'))
      restoreBaseline()

      for (const { material } of floors) {
        material.onBeforeCompile = () => {}
        material.customProgramCacheKey = () => 'cascade-diagnostic-caustics-off'
        material.needsUpdate = true
      }
      frames.push(capture('cascade-optics-floor-caustics-off'))
      restoreBaseline()

      presentation.sun.castShadow = false
      internals.renderer.shadowMap.needsUpdate = true
      frames.push(capture('cascade-optics-sun-shadows-off'))
      restoreBaseline()

      for (const { material } of solidOptics) {
        material.clearcoat = 0; material.envMapIntensity = 0
        material.needsUpdate = true
      }
      frames.push(capture('cascade-optics-porcelain-clearcoat-reflections-off'))
      restoreBaseline()

      // Replace exactly the same porcelain and floor slots, retaining geometry,
      // depth testing, water and lighting to separate raster artifacts from PBR.
      for (const { mesh, material } of solidMeshes) {
        const replace = (slot: THREE.Material) => solids.has(slot as THREE.MeshPhysicalMaterial) ? basic : slot
        mesh.material = Array.isArray(material) ? material.map(replace) : replace(material)
      }
      frames.push(capture('cascade-optics-porcelain-basic-material'))
      restoreBaseline()
      basic.dispose()
      return { time: snapshot.cascade.time, massError: snapshot.diagnostics.massError, frames }
    } finally {
      view.dispose(); mount.remove()
    }
  })
  for (const frame of result.frames) {
    const path = testInfo.outputPath(`${frame.name}.png`)
    await writeFile(path, Buffer.from(frame.image.split(',')[1], 'base64'))
    await testInfo.attach(frame.name, { path, contentType: 'image/png' })
  }
  const measurements = {
    time: result.time, massError: result.massError,
    frames: result.frames.map(({ image: _image, ...frame }) => frame), errors,
  }
  const measurementPath = testInfo.outputPath('cascade-optics-isolation.json')
  await writeFile(measurementPath, JSON.stringify(measurements, null, 2))
  await testInfo.attach('cascade-optics-isolation', { path: measurementPath, contentType: 'application/json' })
  expect(errors).toEqual([])
  expect(result.time).toBeCloseTo(2, 8)
  for (const frame of result.frames) {
    expect(frame.error, frame.name).toBe(0)
    expect(frame.colorRange, `${frame.name} contains rendered scene pixels`).toBeGreaterThan(16)
  }
  for (const frame of result.frames.slice(1)) {
    expect(frame.changedPixels, `${frame.name} changes actual pixels from baseline`).toBeGreaterThan(0)
  }
})
