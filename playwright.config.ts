import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-ui-r1-e2e-'))
const dbPath = path.join(runtimeDir, 'app.db')

process.once('exit', () => {
  fs.rmSync(runtimeDir, { recursive: true, force: true })
})

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'line',
  outputDir: path.join(runtimeDir, 'artifacts'),
  use: {
    baseURL: 'http://127.0.0.1:3211',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'npm run dev -- -p 3211',
    url: 'http://127.0.0.1:3211/login',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      MOCK: 'true',
      WORKER_ENABLED: 'false',
      ADMIN_LINUXDO_IDS: '1',
      DB_PATH: dbPath,
      MOCK_CPA_PATH: path.join(runtimeDir, 'mock-cpa.json'),
      SESSION_SECRET: 'x'.repeat(64),
      APP_BASE_URL: 'http://127.0.0.1:3211',
      CPA_BASE_URL: '',
      CPA_MANAGEMENT_KEY: '',
      LINUXDO_CLIENT_ID: '',
      LINUXDO_CLIENT_SECRET: '',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
})
