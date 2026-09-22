import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import type * as THREE from 'three'
import type { FreeSurfaceRenderer } from '../src/features/waterSimulation/freeSurface/renderer'
import type { createWaterStudioProject } from '../src/features/waterStudio/presets'
import type { buildFluidLayout } from '../src/features/waterSimulation/freeSurface/layout'
import type { FreeSurfaceSolver } from '../src/features/waterSimulation/freeSurface/solver'
import { visitProjectLibrary } from './helpers/navigation'

test('studio background stays white across materials while shadows and actual raised wall colors remain distinct', async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && /THREE|shader|WebGL/i.test(message.text())) errors.push(message.text()) })
  const bundle = await build({ stdin: {
    contents: `export { FreeSurfaceRenderer } from './src/features/waterSimulation/freeSurface/renderer';
      export { createWaterStudioProject } from './src/features/waterStudio/presets';
      export { buildFluidLayout } from './src/features/waterSimulation/freeSurface/layout';
      export { FreeSurfaceSolver } from './src/features/waterSimulation/freeSurface/solver';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'studio-background-fixture.ts', loader: 'ts',
  }, bundle: true, format: 'iife', platform: 'browser', globalName: 'BackgroundFixture', write: false, logLevel: 'silent' })
  await page.route('**/__background-fixture.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles[0].text }))
  await visitProjectLibrary(page)
  await page.addScriptTag({ url: '/__background-fixture.js' })
  const results = await page.evaluate(() => {
    const fixture = (window as unknown as { BackgroundFixture: {
      FreeSurfaceRenderer: typeof FreeSurfaceRenderer; createWaterStudioProject: typeof createWaterStudioProject
      buildFluidLayout: typeof buildFluidLayout; FreeSurfaceSolver: typeof FreeSurfaceSolver
    } }).BackgroundFixture
    const results = []
    for (const sculpture of ['extruded-flow', 'terraced-fountain'] as const) {
      const layout = fixture.buildFluidLayout(fixture.createWaterStudioProject('garden'))
      const mount = document.createElement('div')
      mount.style.cssText = 'position:fixed;left:0;top:0;width:440px;height:520px'
      document.body.appendChild(mount)
      const view = new fixture.FreeSurfaceRenderer(mount, layout, 'high', sculpture)
      const solver = new fixture.FreeSurfaceSolver(layout)
      for (let i = 0; i < 120; i++) solver.step(1 / 60, 1)
      const snapshot = solver.snapshot()
      const internals = view as unknown as { renderer: THREE.WebGLRenderer; presentation3d: { scene: THREE.Scene; content: THREE.Group } }
      const read = () => {
        view.render(snapshot)
        // Particle snapshots do not draw the separate authored basin view.
        // Redraw it as well after toggling only the shadow receiver.
        view.setLook({})
        const gl = internals.renderer.getContext()
        const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight
        const pixels = new Uint8Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        let sum = 0, count = 0
        for (let y = 8; y < height - 8; y++) for (let x = 8; x < width - 8; x++) {
          if ((x < 28 || x > width - 28) && (y < 28 || y > height - 28)) {
            const i = (y * width + x) * 4
            sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3; count++
          }
        }
        return { pixels, background: sum / count, image: view.canvas.toDataURL('image/png'), error: gl.getError() }
      }
      try {
        view.setViewMode('surface-3d')
        const backgrounds = []
        for (const theme of ['porcelain', 'glacier', 'terrace', 'sage', 'basalt'] as const) {
          view.setLook({ theme, light: 'daylight' })
          const result = read(); backgrounds.push({ theme, brightness: result.background, error: result.error })
        }
        view.setLook({ theme: 'porcelain', wallColor: '#245c98' })
        const colored = read()
        const walls = internals.presentation3d.content.getObjectByName('extruded-maze-walls') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial[]> | undefined
        let wallColor: string | undefined = walls?.material[0].color.getHexString()
        if (!walls) internals.presentation3d.content.traverse(object => {
          const materials = (object as THREE.Mesh).material
          for (const material of materials ? Array.isArray(materials) ? materials : [materials] : []) {
            if (material instanceof Object && 'clearcoat' in material && (material as THREE.MeshPhysicalMaterial).color.getHexString() === '245c98') wallColor = '245c98'
          }
        })
        view.setLook({ gridColor2d: '#ff00ff' })
        const changedGrid = read()
        let gridDifference = 0
        for (let i = 0; i < colored.pixels.length; i++) gridDifference += Math.abs(colored.pixels[i] - changedGrid.pixels[i])
        view.setLook({ wallColor: null })
        const baseline = read()
        const receiver = internals.presentation3d.scene.getObjectByName('studio-ground-shadow-receiver')!
        receiver.visible = false
        const noShadow = read()
        let shadowPixels = 0, shadowContrast = 0
        for (let i = 0; i < baseline.pixels.length; i += 4) {
          const delta = ((noShadow.pixels[i] + noShadow.pixels[i + 1] + noShadow.pixels[i + 2]) - (baseline.pixels[i] + baseline.pixels[i + 1] + baseline.pixels[i + 2])) / 3
          if (delta > 20) { shadowPixels++; shadowContrast += delta }
        }
        const flatBackgrounds = []
        view.setViewMode('free-surface')
        view.setLook({ background2d: 'white' })
        for (const theme of ['porcelain', 'basalt'] as const) {
          view.setLook({ theme })
          flatBackgrounds.push(read().background)
        }
        results.push({ sculpture, backgrounds, flatBackgrounds, wallColor, gridDifference, shadowPixels, shadowContrast: shadowContrast / shadowPixels, baselineImage: baseline.image, coloredImage: colored.image })
      } finally { view.dispose(); mount.remove() }
    }
    return results
  })
  for (const { baselineImage, coloredImage, ...result } of results) {
    await writeFile(info.outputPath(`${result.sculpture}-white-background.png`), Buffer.from(baselineImage.split(',')[1], 'base64'))
    await writeFile(info.outputPath(`${result.sculpture}-colored-walls.png`), Buffer.from(coloredImage.split(',')[1], 'base64'))
    await writeFile(info.outputPath(`${result.sculpture}-measurements.json`), JSON.stringify(result, null, 2))
    for (const background of result.backgrounds) { expect(background.brightness).toBeGreaterThan(248); expect(background.error).toBe(0) }
    expect(Math.max(...result.backgrounds.map(b => b.brightness)) - Math.min(...result.backgrounds.map(b => b.brightness))).toBeLessThan(1)
    for (const value of result.flatBackgrounds) expect(value).toBeGreaterThan(254)
    expect(result.wallColor).toBe('245c98')
    expect(result.gridDifference).toBe(0)
    expect(result.shadowPixels).toBeGreaterThan(100)
    expect(result.shadowContrast).toBeGreaterThan(35)
  }
  expect(errors).toEqual([])
})
