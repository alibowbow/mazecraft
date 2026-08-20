import { defineConfig, devices } from '@playwright/test'

const testPort = Number(process.env.PLAYWRIGHT_PORT ?? 4173)

export default defineConfig({
  testDir: './e2e',
  // The initial bootstrap file is retained for branch history but superseded by
  // blender-water-runtime.spec.ts, which performs the awaited DOM assertions.
  testIgnore: ['**/blender-water.spec.ts'],
  fullyParallel: false,
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
