// playwright.config.mjs — UI tests (tests/ui). Run: npm run test:ui
// Boots the real server on an isolated port with an operator password.
// Needs MongoDB + Redis like the e2e suites (MONGO_URI / REDIS_URL).
import { defineConfig, devices } from '@playwright/test'

export const PORT = 3105
export const OPERATOR_PASSWORD = 'ui-test-senha'

export default defineConfig({
  testDir: 'tests/ui',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: '**/player.spec.mjs' },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: '**/player.spec.mjs' },
  ],
  webServer: {
    command: 'node src/server.js',
    url: `http://localhost:${PORT}/health/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
      OPERATOR_PASSWORD,
      QUEUE_JOIN_RATE_MAX: '1000',
      QUEUE_SWEEP_MS: '500',
    },
  },
})
