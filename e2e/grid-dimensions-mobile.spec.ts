import { expect, test, type Page } from '@playwright/test'

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
})

interface StoredDimensions {
  grid: { rows: number; cols: number }
  mazeGraph: { rows: number; cols: number }
}

interface StoredGeneration {
  updatedAt: string
  seed: string
  mazeGraph: string
}

async function latestStoredDimensions(page: Page): Promise<StoredDimensions | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mazecraft-core')
      request.addEventListener('success', () => resolve(request.result), { once: true })
      request.addEventListener(
        'error',
        () => reject(request.error ?? new Error('프로젝트 저장소를 열 수 없습니다.')),
        { once: true },
      )
    })

    try {
      const projects = await new Promise<
        Array<{
          updatedAt: string
          grid: { rows: number; cols: number }
          mazeGraph: { rows: number; cols: number }
        }>
      >((resolve, reject) => {
        const transaction = database.transaction('projects', 'readonly')
        const request = transaction.objectStore('projects').getAll()
        request.addEventListener('success', () => resolve(request.result), { once: true })
        request.addEventListener(
          'error',
          () => reject(request.error ?? new Error('프로젝트를 읽을 수 없습니다.')),
          { once: true },
        )
      })
      const latest = projects.sort(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )[0]
      if (!latest) return null
      return {
        grid: { rows: latest.grid.rows, cols: latest.grid.cols },
        mazeGraph: { rows: latest.mazeGraph.rows, cols: latest.mazeGraph.cols },
      }
    } finally {
      database.close()
    }
  })
}

async function latestStoredGeneration(page: Page): Promise<StoredGeneration | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mazecraft-core')
      request.addEventListener('success', () => resolve(request.result), { once: true })
      request.addEventListener(
        'error',
        () => reject(request.error ?? new Error('프로젝트 저장소를 열 수 없습니다.')),
        { once: true },
      )
    })

    try {
      const projects = await new Promise<
        Array<{ updatedAt: string; seed: string; mazeGraph: unknown }>
      >((resolve, reject) => {
        const request = database.transaction('projects', 'readonly').objectStore('projects').getAll()
        request.addEventListener('success', () => resolve(request.result), { once: true })
        request.addEventListener(
          'error',
          () => reject(request.error ?? new Error('프로젝트를 읽을 수 없습니다.')),
          { once: true },
        )
      })
      const latest = projects.sort(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )[0]
      return latest
        ? {
            updatedAt: latest.updatedAt,
            seed: latest.seed,
            mazeGraph: JSON.stringify(latest.mazeGraph),
          }
        : null
    } finally {
      database.close()
    }
  })
}

async function openGridSettings(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /기본 미로/ }).click()
  await expect(page.getByLabel('프로젝트 제목')).toBeVisible()
  await page.locator('.mobile-tabs').getByRole('button', { name: '미로', exact: true }).click()
}

test('15. 모바일에서 가로·세로 셀을 순차 입력해 해당 크기의 미로를 다시 생성한다', async ({
  page,
}) => {
  test.setTimeout(45_000)
  await openGridSettings(page)

  const columns = page.getByLabel('가로 셀', { exact: true })
  const rows = page.getByLabel('세로 셀', { exact: true })

  await columns.clear()
  await expect(columns).toHaveValue('')
  await columns.pressSequentially('36')
  await expect(columns).toHaveValue('36')

  await rows.clear()
  await expect(rows).toHaveValue('')
  await rows.pressSequentially('18')
  await expect(rows).toHaveValue('18')

  await page
    .getByRole('button', { name: '새 Seed로 미로 다시 생성', exact: true })
    .click()

  await expect(columns).toBeDisabled()
  await expect(rows).toBeDisabled()
  await expect(page.getByRole('combobox', { name: '난이도', exact: true })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: 'Seed', exact: true })).toBeDisabled()

  await expect(page.locator('.canvas-statusbar')).toContainText('36×18', {
    timeout: 20_000,
  })
  await expect
    .poll(() => latestStoredDimensions(page), { timeout: 20_000 })
    .toEqual({
      grid: { rows: 18, cols: 36 },
      mazeGraph: { rows: 18, cols: 36 },
    })
})

test('15.1 모바일 크기 초안은 취소·보정할 수 있고 생성 전에는 실제 미로를 바꾸지 않는다', async ({
  page,
}) => {
  await openGridSettings(page)

  const columns = page.getByLabel('가로 셀', { exact: true })
  const rows = page.getByLabel('세로 셀', { exact: true })
  const status = page.locator('.canvas-statusbar')

  await columns.fill('36')
  await columns.press('Escape')
  await expect(columns).toHaveValue('24')

  await rows.clear()
  await rows.blur()
  await expect(rows).toHaveValue('24')

  await page.getByRole('button', { name: '32×24', exact: true }).click()
  await expect(columns).toHaveValue('32')
  await expect(rows).toHaveValue('24')
  await expect(status).toContainText('24×24')
  await expect.poll(() => latestStoredDimensions(page)).toEqual({
    grid: { rows: 24, cols: 24 },
    mazeGraph: { rows: 24, cols: 24 },
  })

  await columns.fill('7')
  await columns.blur()
  await expect(columns).toHaveValue('8')
  await rows.fill('151')
  await rows.press('Enter')
  await expect(rows).toHaveValue('150')
  await expect(status).toContainText('24×24')
})

test('15.seed-a Seed를 비워 두면 클릭할 때마다 새 Seed와 새 미로를 만든다', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  await openGridSettings(page)

  const seedInput = page.getByRole('textbox', { name: 'Seed', exact: true })
  const generate = page.getByRole('button', {
    name: '새 Seed로 미로 다시 생성',
    exact: true,
  })
  await expect(seedInput).toHaveValue('')
  if (process.env.CAPTURE_UI) {
    await page.screenshot({ path: testInfo.outputPath('seed-panel.png'), fullPage: true })
  }
  const initial = await latestStoredGeneration(page)
  expect(initial).not.toBeNull()

  await generate.click()
  await expect(generate).toBeDisabled()
  await expect(generate).toBeEnabled({ timeout: 20_000 })
  await expect(seedInput).toHaveValue('')
  await expect
    .poll(async () => (await latestStoredGeneration(page))?.seed, { timeout: 10_000 })
    .not.toBe(initial!.seed)
  const first = await latestStoredGeneration(page)
  expect(first).not.toBeNull()

  await generate.click()
  await expect(generate).toBeDisabled()
  await expect(generate).toBeEnabled({ timeout: 20_000 })
  await expect(seedInput).toHaveValue('')
  await expect
    .poll(async () => (await latestStoredGeneration(page))?.seed, { timeout: 10_000 })
    .not.toBe(first!.seed)
  const second = await latestStoredGeneration(page)
  expect(second).not.toBeNull()
  expect(second!.mazeGraph).not.toBe(first!.mazeGraph)
})

test('15.seed-b Seed를 직접 입력한 경우에만 같은 미로를 재현한다', async ({ page }) => {
  test.setTimeout(60_000)
  await openGridSettings(page)

  const seedInput = page.getByRole('textbox', { name: 'Seed', exact: true })
  const replay = page.getByRole('button', {
    name: '입력한 Seed로 미로 재현',
    exact: true,
  })
  await seedInput.fill('repeatable-mobile-seed')
  await expect(replay).toBeVisible()
  await replay.click()
  await expect(replay).toBeDisabled()
  await expect(seedInput).toHaveValue('', { timeout: 20_000 })
  await expect
    .poll(async () => (await latestStoredGeneration(page))?.seed, { timeout: 10_000 })
    .toBe('repeatable-mobile-seed')

  const first = await latestStoredGeneration(page)
  expect(first?.seed).toBe('repeatable-mobile-seed')
  await page.getByRole('button', { name: '현재 Seed 사용', exact: true }).click()
  await expect(seedInput).toHaveValue('repeatable-mobile-seed')

  await replay.click()
  await expect(replay).toBeDisabled()
  await expect(seedInput).toHaveValue('', { timeout: 20_000 })
  await expect
    .poll(async () => (await latestStoredGeneration(page))?.updatedAt, { timeout: 10_000 })
    .not.toBe(first!.updatedAt)
  const second = await latestStoredGeneration(page)
  expect(second?.seed).toBe(first?.seed)
  expect(second?.mazeGraph).toBe(first?.mazeGraph)
})
