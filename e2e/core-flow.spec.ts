import { expect, test, type Page } from '@playwright/test'
import { createDefaultProject, solveMaze, type CellPosition, type MazeProject } from '../src/core/maze'
import { createShareLink, createSharePayload } from '../src/features/share'

const createFixture = (overrides: Partial<MazeProject> = {}) =>
  createDefaultProject({
    title: '브라우저 검증 미로',
    seed: 'browser-verification',
    grid: { rows: 8, cols: 8, minimumCellPixels: 8 },
    secretReveal: {
      content: { kind: 'message', message: '완주해서 열린 비밀 메시지' },
      mode: 'on-complete',
      animation: 'fade',
    },
    ...overrides,
  })

const pathDirections = (path: CellPosition[]) =>
  path.slice(1).map((cell, index) => {
    const previous = path[index]
    if (cell.row < previous.row) return 'ArrowUp'
    if (cell.row > previous.row) return 'ArrowDown'
    if (cell.col < previous.col) return 'ArrowLeft'
    return 'ArrowRight'
  })

async function importFixture(page: Page, project = createFixture()) {
  await page.goto('/')
  await page.locator('input[type="file"][accept*=".mazecraft"]').setInputFiles({
    name: 'fixture.mazecraft',
    mimeType: 'application/vnd.mazecraft+json',
    buffer: Buffer.from(JSON.stringify(project)),
  })
  await expect(page.getByLabel('프로젝트 제목')).toHaveValue(project.title)
  return project
}

async function createBasic(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /기본 미로/ }).click()
  await expect(page.getByLabel('프로젝트 제목')).toBeVisible()
}

async function enterMazeStep(page: Page) {
  await page.locator('.studio-workflow button').filter({ hasText: '미로' }).click()
  await expect(page.getByText('MAZE IQ · 품질 분석')).toBeVisible()
}

async function completeFixture(page: Page, project: MazeProject) {
  const beginButton = page.getByRole('button', { name: /혼자 플레이/ })
  if (!page.url().includes('#/play')) {
    const workflowTest = page.locator('.studio-workflow button').filter({ hasText: '테스트' })
    await workflowTest.click()
    await page.getByRole('button', { name: '직접 플레이 테스트' }).click()
  }
  await beginButton.click()
  const canvas = page.locator('canvas')
  await canvas.click()
  const path = solveMaze(project.mazeGraph, project.startCell, project.endCell).path
  for (const key of pathDirections(path)) await page.keyboard.press(key)
  await expect(page.getByText('이야기가 열렸습니다')).toBeVisible()
}

test('1. 새 기본 미로를 생성한다', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('LIVE MAZE', { exact: true })).toHaveCount(0)
  await createBasic(page)
  await expect(page.locator('canvas')).toBeVisible()
  await expect(page.getByText(/24×24/)).toBeVisible()
})

test('2. 난이도를 바꾸고 Worker 후보를 재생성한다', async ({ page }) => {
  await createBasic(page)
  await enterMazeStep(page)
  await page.locator('.inspector select').first().selectOption('hard')
  await page.getByRole('button', { name: /미로 다시 생성/ }).click()
  await expect(page.getByText(/난이도에 맞는 후보/)).toBeVisible()
  await expect(page.getByText(/난이도에 맞는 후보/)).toBeHidden({ timeout: 15_000 })
  await expect(page.getByText('저장됨')).toBeVisible({ timeout: 5_000 })
})

test('3. 방향키로 완주하고 경계 밖으로 나가지 않는다', async ({ page }) => {
  const project = await importFixture(page)
  await completeFixture(page, project)
  await expect(page.getByText(/내 기록/)).toBeVisible()
})

test('4. 완주 후 시크릿 메시지를 공개한다', async ({ page }) => {
  const project = await importFixture(page)
  await completeFixture(page, project)
  await expect(page.locator('.completion-secret')).toHaveText('완주해서 열린 비밀 메시지')
})

test('5. 자동 저장 후 새로고침해 프로젝트를 복구한다', async ({ page }) => {
  await createBasic(page)
  const title = `복구 검증 ${Date.now()}`
  await page.getByLabel('프로젝트 제목').fill(title)
  await expect(page.getByText('저장됨')).toBeVisible({ timeout: 5_000 })
  await page.reload()
  await expect(page.getByLabel('프로젝트 제목')).toHaveValue(title)
})

test('6. 프로젝트 파일을 내보내고 다시 불러온다', async ({ page }) => {
  await importFixture(page)
  await page.locator('.studio-workflow button').filter({ hasText: '공유' }).click()
  await page.getByRole('button', { name: /파일로 내보내기/ }).click()
  await page.getByRole('button', { name: '프로젝트' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: /파일 저장/ }).click()
  const file = await download
  expect(file.suggestedFilename()).toContain('.mazecraft')
  await page.getByRole('button', { name: '닫기', exact: true }).last().click()
  await page.getByLabel('홈으로').click()
  await page.locator('input[type="file"][accept*=".mazecraft"]').setInputFiles(await file.path())
  await expect(page.getByLabel('프로젝트 제목')).toHaveValue('브라우저 검증 미로')
})

test('7. 공유 링크는 곧바로 플레이 화면으로 열린다', async ({ page, context }) => {
  await importFixture(page)
  await page.getByRole('button', { name: '공유', exact: true }).click()
  const link = await page.locator('.dialog input[readonly]').inputValue()
  expect(link).toContain('#/play?data=')
  const shared = await context.newPage()
  await shared.goto(link)
  await expect(shared.getByText('SHARED CHALLENGE')).toBeVisible()
  await expect(shared.getByRole('button', { name: /혼자 플레이/ })).toBeVisible()
})

test('8. 공유 미로 리믹스는 다른 프로젝트 ID를 만든다', async ({ page, baseURL }) => {
  const project = createFixture({ id: 'original-browser-id', remixAllowed: true })
  const link = createShareLink(createSharePayload(project), baseURL ?? 'http://127.0.0.1:4173/')
  expect(link.ok).toBe(true)
  if (!link.ok) return
  await page.goto(link.url)
  await completeFixture(page, project)
  await page.getByRole('button', { name: /이 미로 리믹스/ }).click()
  await expect(page.getByLabel('프로젝트 제목')).toHaveValue(/리믹스/)
  const id = await page.evaluate(async () => {
    const request = indexedDB.open('mazecraft-core')
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result)
    })
    const transaction = db.transaction('projects', 'readonly')
    const projects = await new Promise<any[]>((resolve) => {
      const all = transaction.objectStore('projects').getAll()
      all.onsuccess = () => resolve(all.result)
    })
    return projects.find((item) => item.title.includes('리믹스'))?.id
  })
  expect(id).not.toBe('original-browser-id')
})

test('9. 벽 편집 뒤 실행 취소와 다시 실행을 제공한다', async ({ page }) => {
  await importFixture(page)
  await enterMazeStep(page)
  const undo = page.getByRole('button', { name: '실행 취소' }).first()
  await expect(undo).toBeDisabled()
  await page.getByRole('button', { name: '직접 수정', exact: true }).click()
  await page.getByRole('button', { name: /좌우 반전/ }).click()
  await expect(undo).toBeEnabled()
  await undo.click()
  await expect(page.getByRole('button', { name: '다시 실행' }).first()).toBeEnabled()
})

test('10. PNG와 SVG 파일을 실제 다운로드한다', async ({ page }) => {
  await importFixture(page)
  await page.locator('.studio-workflow button').filter({ hasText: '공유' }).click()
  await page.getByRole('button', { name: /파일로 내보내기/ }).click()
  const pngDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /파일 저장/ }).click()
  expect((await pngDownload).suggestedFilename()).toContain('.png')
  await page.getByRole('button', { name: 'SVG' }).click()
  const svgDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /파일 저장/ }).click()
  expect((await svgDownload).suggestedFilename()).toContain('.svg')
})

test('11. 모바일에서 가로 스크롤 없이 캔버스와 탭을 조작한다', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await createBasic(page)
  await expect(page.locator('canvas')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  expect(
    await page.locator('.toolbar-button, .mobile-tabs button').evaluateAll((elements) =>
      elements
        .filter((element) => {
          const style = getComputedStyle(element)
          return style.display !== 'none' && style.visibility !== 'hidden'
        })
        .filter((element) => {
          const bounds = element.getBoundingClientRect()
          return bounds.width < 44 || bounds.height < 44
        }).length,
    ),
  ).toBe(0)
  await page.locator('.mobile-tabs button').filter({ hasText: '미로' }).click()
  await expect(page.locator('.inspector')).toHaveClass(/open/)
  await page.locator('.mobile-sheet-scrim').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.inspector')).not.toHaveClass(/open/)

  await page.locator('.mobile-tabs button').filter({ hasText: '게임' }).click()
  await page.getByRole('button', { name: '플레이 테스트', exact: true }).click()
  await page.getByRole('button', { name: /혼자 플레이/ }).click()
  expect(
    await page.locator('.player-hud').evaluate((hud) => {
      const bounds = hud.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= window.innerWidth
    }),
  ).toBe(true)
  expect(
    await page.locator('.hud-actions button, .player-dpad button, .hint-button').evaluateAll(
      (elements) =>
        elements.filter((element) => {
          const bounds = element.getBoundingClientRect()
          return bounds.width < 44 || bounds.height < 44
        }).length,
    ),
  ).toBe(0)
})

test('12. 외부 생성 요청과 콘솔 오류 없이 주요 UI를 렌더링한다', async ({ page }) => {
  const consoleErrors: string[] = []
  const outsideRequests: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) outsideRequests.push(request.url())
  })
  await createBasic(page)
  await page.waitForTimeout(500)
  expect(await page.locator('body').innerText()).not.toContain('인공지능')
  expect(outsideRequests).toEqual([])
  expect(consoleErrors).toEqual([])
  await expect(page.locator('.vite-error-overlay')).toHaveCount(0)
})

test('13. 주요 화면 크기와 폴더블 회전에서 상태와 가로 폭을 보존한다', async ({ page }) => {
  await importFixture(page)
  const viewports = [
    { width: 320, height: 568 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 884, height: 344 },
    { width: 344, height: 884 },
  ]

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(40)
    await expect(page.getByLabel('프로젝트 제목')).toHaveValue('브라우저 검증 미로')
    await expect(page.locator('canvas')).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
  }
})

test('14. 정답 경로를 출발점부터 점진적으로 그리고 다시 재생한다', async ({ page }) => {
  await importFixture(page)
  const canvas = page.locator('canvas')
  const image = () => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())
  const hidden = await image()

  const solutionButton = page.getByRole('button', { name: '정답 경로 그리기' })
  await solutionButton.click()
  await expect(page.getByRole('button', { name: '정답 경로 숨기기' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.waitForTimeout(40)
  const start = await image()
  await page.waitForTimeout(360)
  const middle = await image()
  await page.waitForTimeout(900)
  const complete = await image()

  expect(start).not.toBe(hidden)
  expect(middle).not.toBe(start)
  expect(complete).not.toBe(middle)

  await page.getByRole('button', { name: '정답 경로 숨기기' }).click()
  await expect(solutionButton).toHaveAttribute('aria-pressed', 'false')
  await solutionButton.click()
  await page.waitForTimeout(40)
  const replayStart = await image()
  expect(replayStart).not.toBe(complete)
})

test('15. 3D 물이 최상단 입구에서 최하단 출구 방향으로 흐른다', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 360, height: 800 })
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await importFixture(page)
  await page.locator('.mobile-tabs button').filter({ hasText: '테스트' }).click()
  await page.getByLabel('효과 품질').selectOption('low')

  await page
    .getByRole('button', { name: '3D 물 시뮬레이션', exact: true })
    .click()
  const stage = page.getByTestId('water-simulation-stage')
  await expect(stage).toBeVisible()
  await expect(stage).toHaveAttribute('data-start-edge', 'top')
  await expect(stage).toHaveAttribute('data-end-edge', 'bottom')
  await expect(stage).toHaveAttribute('data-quality', 'low')
  await expect(stage).toHaveAttribute(
    'data-fluid-model',
    'continuous-feed-hydraulic',
  )
  await expect(stage).toHaveAttribute(
    'data-inlet-renderer',
    'coupled-gravity-jet',
  )
  await expect(stage).toHaveAttribute(
    'data-water-continuity',
    'coupled-source-surface',
  )
  await expect(stage).toHaveAttribute('data-renderer', 'ready', { timeout: 15_000 })
  await expect(stage.locator('canvas.water-simulation-canvas')).toBeVisible()
  expect(
    Number(await stage.getAttribute('data-inlet-drop-height')),
  ).toBeGreaterThan(2)
  expect(
    Number(await stage.getAttribute('data-inlet-contact-gap')),
  ).toBeLessThanOrEqual(0.001)

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
  expect(
    await page
      .locator('.water-simulation-controls button, .water-simulation-controls select')
      .evaluateAll(
        (elements) =>
          elements.filter((element) => {
            const bounds = element.getBoundingClientRect()
            return bounds.width < 44 || bounds.height < 44
          }).length,
      ),
  ).toBe(0)

  await page.getByRole('button', { name: '물 시뮬레이션 일시정지' }).click()
  await expect(stage).toHaveAttribute('data-phase', 'paused')
  const pausedCount = Number(await stage.getAttribute('data-filled-cells'))
  await page.waitForTimeout(320)
  expect(Number(await stage.getAttribute('data-filled-cells'))).toBe(pausedCount)

  await page.getByRole('button', { name: '물 시뮬레이션 재생' }).click()
  await page.getByLabel('물 흐름 속도').selectOption('4')
  await page.getByRole('button', { name: '처음부터', exact: true }).click()
  await expect(stage).toHaveAttribute('data-reached-exit', 'true', {
    timeout: 15_000,
  })
  await expect(stage).toHaveAttribute('data-outlet-visible', 'true')
  expect(
    Number(await stage.getAttribute('data-outlet-drop-height')),
  ).toBeGreaterThan(1.4)

  await page.getByRole('button', { name: '3D 물 시뮬레이션 닫기' }).click()
  await expect(stage).toHaveCount(0)
  expect(consoleErrors).toEqual([])
})
