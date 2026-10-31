/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? ''
// Link previews need absolute URLs. Set SITE_URL when deploying to another domain.
const siteUrl = (process.env.SITE_URL ?? 'https://mazecraft.vercel.app').replace(/\/+$/, '')

const siteUrlInHtml: Plugin = {
  name: 'mazecraft-site-url',
  transformIndexHtml: (html) => html.replace(/__SITE_URL__/g, siteUrl),
}

export default defineConfig({
  plugins: [react(), siteUrlInHtml],
  base: './',
  worker: { format: 'es' },
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_COMMIT__: JSON.stringify(commit.slice(0, 7)),
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] }
  }
})
