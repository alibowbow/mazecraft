import { expect, test, type Page } from '@playwright/test'

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
})

async function createBasic(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /기본 미로/ }).click()
  await expect(page.getByLabel('프로젝트 제목')).toBeVisible()
}

test('15.2 모바일 프로젝트 메뉴는 하나의 화면 내 액션 시트로 열린다', async ({ page }, testInfo) => {
  await createBasic(page)
  await page.getByLabel('프로젝트 제목').fill('첫 번째 미로')
  await page.getByRole('button', { name: '홈으로' }).click()
  await page.getByRole('button', { name: /기본 미로/ }).click()
  await page.getByLabel('프로젝트 제목').fill('두 번째 미로')
  await page.getByRole('button', { name: '홈으로' }).click()

  const menuButtons = page.getByRole('button', { name: /미로 메뉴$/ })
  await expect(menuButtons).toHaveCount(2)
  await menuButtons.first().click()

  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await expect(page.locator('.home-shell')).toHaveAttribute('inert', '')
  await expect(page.locator('.home-shell')).toHaveAttribute('aria-hidden', 'true')
  await expect(sheet.getByRole('button', { name: '프로젝트 메뉴 닫기' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: /계속 편집/ })).toBeVisible()
  await expect(sheet.getByRole('button', { name: /복제/ })).toBeVisible()
  await expect(sheet.getByRole('button', { name: /내보내기/ })).toBeVisible()
  await expect(sheet.getByRole('button', { name: /삭제/ })).toBeVisible()

  const bounds = await sheet.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)

  if (process.env.CAPTURE_UI) {
    await page.screenshot({ path: testInfo.outputPath('home-project-actions.png'), fullPage: true })
  }

  await page.locator('.mc-bottom-sheet-backdrop').click({ position: { x: 8, y: 8 } })
  await expect(sheet).toBeHidden()
  await expect(page.locator('.home-shell')).not.toHaveAttribute('inert', '')
})

test('15.3 모바일에서 도구 선택 즉시 캔버스로 돌아가고 한 획을 한 번에 취소한다', async ({
  page,
}, testInfo) => {
  await createBasic(page)
  await page.getByLabel('프로젝트 제목').fill('편집해도 유지되는 제목')
  await page.locator('.mobile-tabs').getByRole('button', { name: '미로', exact: true }).click()
  await page.getByRole('button', { name: '직접 수정', exact: true }).click()
  await page.getByRole('button', { name: '벽 열기', exact: true }).click()

  const inspector = page.locator('.inspector')
  const dock = page.locator('.mobile-edit-dock')
  await expect(inspector).not.toHaveClass(/open/)
  await expect(dock).toBeVisible()
  await expect(page.locator('.mobile-tabs')).toBeHidden()
  await expect(page.locator('.canvas-edit-hint')).toContainText('벽 열기')

  const dockMetrics = await dock.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect()
      const centre = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      )
      return {
        width: bounds.width,
        height: bounds.height,
        inViewport:
          bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.right <= window.innerWidth &&
          bounds.bottom <= window.innerHeight,
        hittable: centre === button || button.contains(centre),
      }
    }),
  )
  expect(dockMetrics.every((button) => button.width >= 44 && button.height >= 44)).toBe(true)
  expect(dockMetrics.every((button) => button.inViewport && button.hittable)).toBe(true)

  if (process.env.CAPTURE_UI) {
    await page.screenshot({ path: testInfo.outputPath('studio-edit-dock.png'), fullPage: true })
  }

  const target = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mazecraft-core')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const projects = await new Promise<any[]>((resolve, reject) => {
      const request = database.transaction('projects', 'readonly').objectStore('projects').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    const project = projects.sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )[0]
    const graph = project.mazeGraph
    for (const cell of graph.cells) {
      if (!cell.active) continue
      const right = graph.cells[cell.row * graph.cols + cell.col + 1]
      if (cell.col + 1 < graph.cols && right?.active && cell.walls.right) {
        return { row: cell.row, col: cell.col, wall: 'right', rows: graph.rows, cols: graph.cols, snapshot: JSON.stringify(graph) }
      }
      const bottom = graph.cells[(cell.row + 1) * graph.cols + cell.col]
      if (cell.row + 1 < graph.rows && bottom?.active && cell.walls.bottom) {
        return { row: cell.row, col: cell.col, wall: 'bottom', rows: graph.rows, cols: graph.cols, snapshot: JSON.stringify(graph) }
      }
    }
    throw new Error('편집할 닫힌 내부 벽을 찾지 못했습니다.')
  })

  const canvas = page.locator('.maze-canvas-shell canvas')
  const before = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())
  const canvasBounds = await canvas.boundingBox()
  expect(canvasBounds).not.toBeNull()
  const scale = Math.min(
    (canvasBounds!.width - 56) / target.cols,
    (canvasBounds!.height - 56) / target.rows,
  )
  const originX = canvasBounds!.x + (canvasBounds!.width - target.cols * scale) / 2
  const originY = canvasBounds!.y + (canvasBounds!.height - target.rows * scale) / 2
  const point = target.wall === 'right'
    ? { x: originX + (target.col + 1) * scale, y: originY + (target.row + 0.5) * scale }
    : { x: originX + (target.col + 0.5) * scale, y: originY + (target.row + 1) * scale }

  await page.touchscreen.tap(point.x, point.y)
  await expect(dock.getByRole('button', { name: '실행 취소' })).toBeEnabled()
  const edited = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())
  expect(edited).not.toBe(before)

  await dock.getByRole('button', { name: '실행 취소' }).click()
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mazecraft-core')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const projects = await new Promise<any[]>((resolve, reject) => {
      const request = database.transaction('projects', 'readonly').objectStore('projects').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    const latest = projects.sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )[0]
    return JSON.stringify(latest?.mazeGraph)
  })).toBe(target.snapshot)
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL()))
    .not.toBe(edited)
  await expect(page.getByLabel('프로젝트 제목')).toHaveValue('편집해도 유지되는 제목')
})

test('15.4 모바일 그리기는 벽 도구가 아니라 실루엣 획으로 저장된다', async ({ page }) => {
  test.setTimeout(30_000)
  await createBasic(page)
  await page.locator('.mobile-tabs').getByRole('button', { name: '형태', exact: true }).click()
  await page.getByRole('button', { name: '그리기', exact: true }).click()

  await expect(page.locator('.inspector')).not.toHaveClass(/open/)
  await expect(page.locator('.canvas-edit-hint')).toContainText('실루엣 그리기')

  const canvas = page.locator('.maze-canvas-shell canvas')
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  const start = { x: bounds!.x + bounds!.width * 0.38, y: bounds!.y + bounds!.height * 0.48 }
  const end = { x: bounds!.x + bounds!.width * 0.62, y: bounds!.y + bounds!.height * 0.58 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 12 })
  await page.mouse.up()

  await expect.poll(async () => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mazecraft-core')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const projects = await new Promise<any[]>((resolve, reject) => {
      const request = database.transaction('projects', 'readonly').objectStore('projects').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    const latest = projects.sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )[0]
    return latest?.shape?.kind === 'drawing' ? latest.shape.paths.length : 0
  }), { timeout: 20_000 }).toBeGreaterThan(0)
})

test('15.5 짧은 가로 화면은 편집 도크를 옆으로 보내 미로 높이를 확보한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 884, height: 344 })
  await createBasic(page)
  await page.locator('.mobile-tabs').getByRole('button', { name: '미로', exact: true }).click()
  await page.getByRole('button', { name: '직접 수정', exact: true }).click()
  await page.getByRole('button', { name: '벽 열기', exact: true }).click()

  const canvas = page.locator('.maze-canvas-shell canvas')
  const dock = page.locator('.mobile-edit-dock')
  const canvasBounds = await canvas.boundingBox()
  const dockBounds = await dock.boundingBox()
  expect(canvasBounds).not.toBeNull()
  expect(dockBounds).not.toBeNull()
  expect(canvasBounds!.width).toBeGreaterThan(700)
  expect(canvasBounds!.height).toBeGreaterThan(170)
  expect(dockBounds!.x).toBeGreaterThan(canvasBounds!.x + canvasBounds!.width)
  await expect(page.locator('.canvas-edit-hint')).toBeHidden()

  const mazePixelBounds = await canvas.evaluate((element) => {
    const target = element as HTMLCanvasElement
    const context = target.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('캔버스 픽셀을 읽을 수 없습니다.')
    const pixels = context.getImageData(0, 0, target.width, target.height).data
    let minimumX = target.width
    let minimumY = target.height
    let maximumX = -1
    let maximumY = -1
    for (let y = 0; y < target.height; y += 1) {
      for (let x = 0; x < target.width; x += 1) {
        const offset = (y * target.width + x) * 4
        if (pixels[offset] < 120 && pixels[offset + 1] < 140 && pixels[offset + 2] < 150) {
          minimumX = Math.min(minimumX, x)
          minimumY = Math.min(minimumY, y)
          maximumX = Math.max(maximumX, x)
          maximumY = Math.max(maximumY, y)
        }
      }
    }
    return {
      width: ((maximumX - minimumX + 1) / target.width) * target.clientWidth,
      height: ((maximumY - minimumY + 1) / target.height) * target.clientHeight,
    }
  })
  expect(mazePixelBounds.width).toBeGreaterThan(120)
  expect(mazePixelBounds.height).toBeGreaterThan(120)

  const buttons = await dock.getByRole('button').evaluateAll((items) =>
    items.map((item) => {
      const bounds = item.getBoundingClientRect()
      return { width: bounds.width, height: bounds.height }
    }),
  )
  expect(buttons.every((button) => button.width >= 44 && button.height >= 44)).toBe(true)
  if (process.env.CAPTURE_UI) {
    await page.screenshot({ path: testInfo.outputPath('studio-edit-landscape.png'), fullPage: true })
  }
})
