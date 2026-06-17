// Playwright E2E конфиг для SVchat.
// URL приложения берётся из переменной SVCHAT_URL (по умолчанию — прод на Render).
//   SVCHAT_URL=http://localhost:8080 npm test   — тесты против локального сервера
const { defineConfig, devices } = require('@playwright/test');

const BASE = process.env.SVCHAT_URL || 'https://svchat-server.onrender.com';

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE,
    headless: true,
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // PW_INSECURE=1 — игнорировать ошибки TLS (например, за корпоративным прокси). Обычно не нужно.
    ignoreHTTPSErrors: !!process.env.PW_INSECURE,
    // PW_EXEC=/путь/к/chrome — использовать свой бинарь Chromium (обычно не нужно).
    launchOptions: process.env.PW_EXEC ? { executablePath: process.env.PW_EXEC, args: ['--no-sandbox'] } : {},
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
