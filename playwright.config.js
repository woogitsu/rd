// Konfiguracja Playwright dla pierwszych testów przeglądarkowych kluczowych
// ścieżek (issue: E2E w CI). Serwer testowy: Node + PGlite (w pamięci) +
// dane wyłącznie syntetyczne (domeny .invalid) — patrz tests/e2e/support/server.js.
//
// Lokalnie Chromium pochodzi z PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers) —
// `npx playwright install` NIE jest tu wywoływane i nie powinno być potrzebne.
// `npm run test:e2e` buduje panele (`pretest:e2e` → `npm run build`) przed
// uruchomieniem testów, bo serwer serwuje zbudowane dist/.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4317);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node tests/e2e/support/server.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
});
