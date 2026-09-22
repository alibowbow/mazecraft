import { expect, test, type Locator, type Page } from '@playwright/test'
import { readShareHash } from '../src/features/share/codec'

async function openStudio(page: Page) {
  await page.goto('/')
  const stage = page.getByTestId('water-studio-canvas')
  await expect(stage).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 })
  const canvas = stage.locator('canvas.water-simulation-canvas')
  await expect(canvas).toHaveAttribute('data-view-mode', 'surface-3d')
  return canvas
}

async function fluidState(canvas: Locator) {
  return {
    time: Number(await canvas.getAttribute('data-basin-time')),
    stored: Number(await canvas.getAttribute('data-basin-stored-volume')),
  }
}

test('water studio starts with live 3D water and tunes appearance without resetting paused flow', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const canvas = await openStudio(page)
  await expect.poll(async () => (await fluidState(canvas)).stored).toBeGreaterThan(0)
  const initialTime = (await fluidState(canvas)).time
  await expect.poll(async () => (await fluidState(canvas)).time).toBeGreaterThan(initialTime)
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
  await expect(page.getByRole('button', { name: '재생', exact: true })).toBeVisible()
  // Allow a solver frame already posted before the pause to reach the UI.
  await page.waitForTimeout(350)
  const paused = await fluidState(canvas)

  await page.getByRole('tab', { name: '재질', exact: true }).click()
  await page.getByRole('button', { name: '글레이셔', exact: true }).click()
  await expect(page.getByTestId('water-studio')).toHaveAttribute('data-theme-name', 'glacier')
  await page.getByRole('tab', { name: '빛', exact: true }).click()
  await page.getByRole('button', { name: /오후의 햇살/ }).click()
  await page.getByRole('tab', { name: '물', exact: true }).click()
  await page.getByRole('button', { name: '물 색상 분홍', exact: true }).click()
  await page.getByRole('button', { name: '잔잔하게', exact: true }).click()
  const inflow = page.getByRole('slider', { name: '유입량', exact: true })
  await inflow.focus()
  await inflow.press('Home')
  await inflow.press('ArrowRight')
  await expect(inflow).toHaveValue('0.15')
  await page.getByRole('button', { name: '물 붓기 켜짐', exact: true }).click()
  await expect(page.getByRole('button', { name: '물 붓기 꺼짐', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: '2D', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-view-mode', 'free-surface')
  await page.getByRole('button', { name: '3D', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-view-mode', 'surface-3d')
  expect(await fluidState(canvas)).toEqual(paused)
  await page.screenshot({ path: testInfo.outputPath('water-studio-tuned.png') })

  await page.reload()
  await expect(page.getByTestId('water-studio-canvas')).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 })
  await expect(page.getByTestId('water-studio')).toHaveAttribute('data-theme-name', 'glacier')
  await page.getByRole('tab', { name: '물', exact: true }).click()
  await expect(page.getByRole('button', { name: '물 색상 분홍', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('slider', { name: '유입량', exact: true })).toHaveValue('0.15')
  expect(errors).toEqual([])
})

test('water studio presets remain editable and can be saved to the project collection', async ({ page }) => {
  test.setTimeout(90_000)
  await openStudio(page)
  await page.getByRole('button', { name: /트윈 플로우/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('트윈 플로우')
  await expect(page.getByTestId('water-studio-canvas')).toHaveAttribute('data-renderer', 'ready')
  await page.getByRole('button', { name: '미로 저장', exact: true }).click()
  await expect(page.getByRole('button', { name: '미로 저장 완료', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '내 미로', exact: true }).click()
  await expect(page.getByRole('button', { name: '← 물 스튜디오', exact: true })).toBeVisible()
  await expect(page.getByText('트윈 플로우', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '← 물 스튜디오', exact: true }).click()
  await page.getByRole('tab', { name: '미로', exact: true }).click()
  await page.getByRole('button', { name: '전체 제작기 · 글자 / 이미지 / 벽 편집', exact: true }).click()
  await expect(page.getByLabel('프로젝트 제목')).toHaveValue('트윈 플로우')
})

test('15.6 mobile water studio keeps the scene visible and tuning controls reachable', async ({ page }, testInfo) => {
  // Software WebGL needs time to read back both full-resolution material views.
  test.setTimeout(120_000)
  const canvas = await openStudio(page)
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight }))
  expect(layout.scrollWidth).toBe(layout.width)
  expect(layout.scrollHeight).toBe(layout.height)
  const bounds = await canvas.boundingBox()
  expect(bounds?.height).toBeGreaterThan(300)
  await page.getByRole('button', { name: '튜닝 열기', exact: true }).click()
  await expect(page.getByRole('button', { name: '튜닝 열기', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('tab', { name: '재질', exact: true }).click()
  await page.getByRole('button', { name: '글레이셔', exact: true }).click()
  await expect(page.getByTestId('water-studio')).toHaveAttribute('data-theme-name', 'glacier')
  await page.screenshot({ path: testInfo.outputPath('mobile-water-tuning.png') })
  await page.getByRole('button', { name: '튜닝 닫기', exact: true }).click()
  await expect(page.getByRole('button', { name: '튜닝 열기', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: '일시정지', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('mobile-water-studio.png') })
})

test('edited water graph survives the editor round trip and opens as water in a fresh shared session', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await openStudio(page)
  await page.getByRole('tab', { name: '미로', exact: true }).click()
  await page.getByRole('button', { name: '전체 제작기 · 글자 / 이미지 / 벽 편집', exact: true }).click()
  await page.getByLabel('프로젝트 제목').fill('편집한 작은 물 미로')
  await page.locator('.studio-stage-rail button').filter({ hasText: '미로' }).click()
  await page.getByLabel('가로 셀', { exact: true }).fill('12')
  await page.getByLabel('세로 셀', { exact: true }).fill('10')
  await page.getByRole('button', { name: '새 Seed로 미로 다시 생성', exact: true }).click()
  await expect(page.locator('.canvas-statusbar')).toContainText('12×10', { timeout: 20_000 })
  await page.getByRole('button', { name: '공유', exact: true }).click()
  const editorLink = await page.locator('.dialog input[readonly]').inputValue()
  const edited = readShareHash(new URL(editorLink).hash)!.project
  expect(edited.mazeGraph.cols).toBe(12)
  expect(edited.mazeGraph.rows).toBe(10)
  await page.getByRole('button', { name: '닫기', exact: true }).last().click()
  await page.getByRole('button', { name: '홈으로', exact: true }).click()
  await expect(page.getByTestId('water-studio-canvas')).toHaveAttribute('data-renderer', 'ready')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('편집한 작은 물 미로')
  await page.getByRole('button', { name: '현재 미로 공유', exact: true }).click()
  const waterLink = await page.locator('.dialog input[readonly]').inputValue()
  expect(waterLink).toContain('#/water?data=')
  const sharedGraph = readShareHash(new URL(waterLink).hash)!.project.mazeGraph
  expect(sharedGraph).toEqual(edited.mazeGraph)
  await expect(page.getByRole('dialog').getByRole('checkbox')).toHaveCount(0)

  await page.getByRole('button', { name: '닫기', exact: true }).last().click()
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
  const fresh = await browser.newContext()
  try {
    const shared = await fresh.newPage()
    await shared.goto(waterLink)
    await expect(shared.getByTestId('water-studio-canvas')).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 })
    await expect(shared.getByTestId('water-studio-canvas')).toHaveAttribute('data-view-mode', 'surface-3d')
    await expect(shared.getByRole('heading', { level: 1 })).toHaveText('편집한 작은 물 미로')
    await shared.getByRole('button', { name: '일시정지', exact: true }).click()
    await shared.getByRole('button', { name: '현재 미로 공유', exact: true }).click()
    const reopenedLink = await shared.locator('.dialog input[readonly]').inputValue()
    expect(readShareHash(new URL(reopenedLink).hash)!.project.mazeGraph).toEqual(edited.mazeGraph)
  } finally {
    await fresh.close()
  }
})

test('creates a reproducible shaped maze with the original generator and carries it into the full editor', async ({ page }) => {
  test.setTimeout(180_000)
  await openStudio(page)
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
  await page.getByRole('button', { name: '2D', exact: true }).click()
  await page.getByRole('tab', { name: '미로', exact: true }).click()
  await page.getByRole('button', { name: '하트', exact: true }).click()
  await page.getByLabel('가로 셀', { exact: true }).fill('16')
  await page.getByLabel('세로 셀', { exact: true }).fill('14')
  await page.getByRole('button', { name: 'Prim 많은 갈림길', exact: true }).click()
  await page.getByLabel('시드', { exact: true }).fill('my-ceramic-garden')
  await page.getByRole('button', { name: '이 설정으로 미로 생성', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('하트 물 미로')
  await expect(page.getByTestId('water-studio-canvas')).toHaveAttribute('data-renderer', 'ready')
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
  await page.getByRole('button', { name: '현재 미로 공유', exact: true }).click()
  const link = await page.locator('.dialog input[readonly]').inputValue()
  const created = readShareHash(new URL(link).hash)!.project
  expect(created.mazeGraph.cols).toBe(16)
  expect(created.mazeGraph.rows).toBe(14)
  expect(created.mazeGraph.algorithm).toBe('prim')
  expect(created.seed).toBe('my-ceramic-garden')
  expect(created.mazeGraph.cells.filter(cell => !cell.active).length).toBeGreaterThan(0)
  await page.getByRole('button', { name: '닫기', exact: true }).last().click()
  await page.getByRole('button', { name: '전체 제작기 · 글자 / 이미지 / 벽 편집', exact: true }).click()
  await expect(page.getByLabel('프로젝트 제목')).toHaveValue('하트 물 미로')
  await expect(page.locator('.canvas-statusbar')).toContainText('16×14')
})
