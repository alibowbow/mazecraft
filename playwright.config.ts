import { defineConfig, devices } from '@playwright/test'
import { e2eTimeout } from './e2e/helpers/runtimeBudget'

const testPort = Number(process.env.PLAYWRIGHT_PORT ?? 4173)
const ciSuite = process.env.PLAYWRIGHT_SUITE

export default defineConfig({
  testDir: './e2e',
  // The initial bootstrap file is retained for branch history but superseded by
  // blender-water-runtime.spec.ts, which performs the awaited DOM assertions.
  testIgnore: [
    '**/blender-water.spec.ts',
    ...(ciSuite === 'regression' ? ['**/water-studio.spec.ts'] : []),
  ],
  testMatch: ciSuite === 'studio' ? '**/water-studio.spec.ts' : undefined,
  // Studio scenarios each own their page/context. Let sharding split that
  // expensive file by test while still using one WebGL worker per runner.
  fullyParallel: ciSuite === 'studio',
  timeout: e2eTimeout(30_000),
  expect: { timeout: e2eTimeout(5_000) },
  // GitHub runners use software WebGL. Serializing there prevents the two 3D
  // quality scenarios from starving each other's lazy-loaded renderers.
  workers: process.env.CI ? 1 : undefined,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${testPort}`,
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? {
          executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        }
      : undefined,
  },
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${testPort} --strictPort`,
    port: testPort,
    reuseExistingServer: true,
  },
  projects: [
    {
      name: 'desktop',
      grepInvert: /15\./,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    {
      name: 'mobile',
      grep: /(?:11|15)\./,
      use: { ...devices['Galaxy S9+'], viewport: { width: 360, height: 800 } },
    }
  ]
})
