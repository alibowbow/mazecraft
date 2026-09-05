import { expect, type Locator, type Page } from '@playwright/test'
import { createDefaultProject, type MazeProject } from '../../src/core/maze'

export const branchingWaterProject = createDefaultProject({
  title: '공유 입자 수면 검증 미로', seed: 'free-surface-water-e2e',
  grid: { rows: 6, cols: 6, minimumCellPixels: 8 },
})
export const fallingWaterProject = createDefaultProject({
  title: '중력 낙하 검증 수로', seed: 'shared-water-quality',
  grid: { rows: 4, cols: 1, minimumCellPixels: 8 },
})

export async function importWaterProject(page: Page, project: MazeProject, quality: 'low' | 'high', mobile = false) {
  await page.goto('/')
  const importer = page.locator('input[type="file"][accept*=".mazecraft"]')
  if (await importer.count()) {
    await importer.setInputFiles({
      name: 'shared-water.mazecraft', mimeType: 'application/vnd.mazecraft+json',
      buffer: Buffer.from(JSON.stringify(project)),
    })
  } else {
    // A second quality run restores this fixture directly into the editor.
    await expect(page.getByLabel('프로젝트 제목')).toHaveValue(project.title)
  }
  await page.locator(mobile ? '.mobile-tabs button' : '.studio-stage-rail button').filter({ hasText: '테스트' }).click()
  await page.getByLabel('효과 품질').selectOption(quality)
  if (mobile) await page.getByRole('button', { name: '설정 닫기' }).click()
}

export async function openParticleWater(page: Page, mode: 'free-surface' | 'surface-3d' = 'free-surface') {
  await page.getByRole('button', { name: '물 시뮬레이션 열기' }).click()
  const stage = page.getByTestId('water-simulation-stage')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', { timeout: 20_000 })
  await page.getByLabel('물 시뮬레이션 방식').selectOption(mode)
  await expect(stage).toHaveAttribute('data-view-mode', mode)
  await expect(stage).toHaveAttribute('data-fluid-model', 'position-based-free-surface')
  await expect(stage).toHaveAttribute('data-solver-mode', 'worker')
  await expect(stage.locator('canvas.water-simulation-canvas')).toBeVisible()
  return stage
}

export const numberAttribute = async (stage: Locator, name: string) => Number(await stage.getAttribute(name))
export const readWaterState = (stage: Locator) => stage.evaluate(element => ({
  time: Number(element.getAttribute('data-elapsed-ms')),
  particles: Number(element.getAttribute('data-particle-count')),
  injected: Number(element.getAttribute('data-injected-volume')),
  discharged: Number(element.getAttribute('data-outlet-volume')),
  escaped: Number(element.getAttribute('data-escaped-volume')),
  stored: Number(element.getAttribute('data-stored-volume')),
  error: Number(element.getAttribute('data-mass-relative-error')),
}))
export async function pauseWater(page: Page, stage: Locator) {
  await page.getByRole('button', { name: '물 시뮬레이션 일시정지' }).click()
  await expect(stage).toHaveAttribute('data-phase', 'paused')
}

interface WorkerProbe {
  active: number; created: number; terminated: number; contextsLost: number
  fluidLayouts: string[]; fluidInitKeys: string[]; urls: string[]
}
export async function installWorkerProbe(page: Page) {
  await page.addInitScript(() => {
    const state = { active: 0, created: 0, terminated: 0, contextsLost: 0, fluidLayouts: [] as string[], fluidInitKeys: [] as string[], urls: [] as string[] }
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker
        state.active++; state.created++; state.urls.push(String(args[0]))
        const post = worker.postMessage.bind(worker)
        worker.postMessage = ((message: { type?: string; layout?: unknown }, options?: StructuredSerializeOptions) => {
          if (message.type === 'init' && message.layout) {
            state.fluidLayouts.push(JSON.stringify(message.layout))
            state.fluidInitKeys.push(Object.keys(message).sort().join(','))
          }
          post(message, options)
        }) as Worker['postMessage']
        let active = true
        const terminate = worker.terminate.bind(worker)
        worker.terminate = () => {
          if (active) { active = false; state.active--; state.terminated++ }
          terminate()
        }
        return worker
      },
    })
    const seen = new WeakSet<object>()
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const getExtension = prototype.getExtension as (this: WebGLRenderingContext | WebGL2RenderingContext, name: string) => unknown
      prototype.getExtension = function (this: WebGLRenderingContext | WebGL2RenderingContext, name: string) {
        const extension = getExtension.call(this, name) as { loseContext?: () => void } | null
        if (name === 'WEBGL_lose_context' && extension?.loseContext && !seen.has(extension)) {
          seen.add(extension)
          const lose = extension.loseContext.bind(extension)
          extension.loseContext = () => { state.contextsLost++; lose() }
        }
        return extension
      } as typeof prototype.getExtension
    }
    Object.defineProperty(window, '__particleWaterProbe', { get: () => ({ ...state }) })
  })
}
export const readWorkerProbe = (page: Page) => page.evaluate(() => (window as unknown as Window & {
  __particleWaterProbe: WorkerProbe
}).__particleWaterProbe)
