import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Playwright 会在 runner 与 worker 进程分别加载 config。首次加载创建隔离目录并通过环境变量
// 传给 worker；worker 复用同一路径但不注册清理，避免失败后重启 worker 时误删正在使用的 DB。
const inheritedDbPath = process.env.XJM_UI_E2E_DB_PATH
const runtimeDir = inheritedDbPath
  ? path.dirname(inheritedDbPath)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-ui-r1-e2e-'))
const dbPath = inheritedDbPath ?? path.join(runtimeDir, 'app.db')

if (!inheritedDbPath) {
  process.env.XJM_UI_E2E_DB_PATH = dbPath
  process.once('exit', () => {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'line',
  outputDir: path.join(runtimeDir, 'artifacts'),
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: {
    baseURL: 'http://127.0.0.1:3211',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'npm run dev -- -H 127.0.0.1 -p 3211',
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
