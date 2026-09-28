// Konfiguracja Playwright dla pierwszych testów przeglądarkowych kluczowych
// ścieżek (issue: E2E w CI). Serwer testowy: Node + PGlite (w pamięci) +
// dane wyłącznie syntetyczne (domeny .invalid) — patrz tests/e2e/support/server.js.
//
// Lokalnie Chromium pochodzi z PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers) —
// `npx playwright install` NIE jest tu wywoływane i nie powinno być potrzebne.
// `npm run test:e2e` buduje panele (`pretest:e2e` → `npm run build`) przed
// uruchomieniem testów, bo serwer serwuje zbudowane dist/.
//
// Runnery self-hosted i to środowisko nie pobierają nowych przeglądarek
// (brak Dockera/gwarantowanego dostępu do sieci) — wersja @playwright/test
// może oczekiwać nowszej rewizji Chromium niż ta faktycznie obecna w
// PLAYWRIGHT_BROWSERS_PATH (np. po bumpie w package.json). Zamiast pozwolić
// Playwrightowi szukać dokładnej oczekiwanej rewizji (i kończyć się błędem
// „Executable doesn't exist”), wskazujemy jawnie najnowszy katalog
// `chromium-*` faktycznie obecny na dysku. Gdy rewizje się zgadzają, to i
// tak ta sama ścieżka, którą wybrałby Playwright domyślnie — więc nic się
// nie zmienia w normalnym przypadku (np. po `playwright install`).
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4317);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function findExistingChromiumExecutable() {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersPath) return undefined;
  let entries;
  try {
    entries = readdirSync(browsersPath);
  } catch {
    return undefined;
  }
  const revisions = entries
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
  for (const revision of revisions) {
    const executablePath = path.join(browsersPath, `chromium-${revision}`, 'chrome-linux', 'chrome');
    if (existsSync(executablePath)) return executablePath;
  }
  return undefined;
}

const existingChromiumExecutable = findExistingChromiumExecutable();

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
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(existingChromiumExecutable
          ? { launchOptions: { executablePath: existingChromiumExecutable } }
          : {}),
      },
    },
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
