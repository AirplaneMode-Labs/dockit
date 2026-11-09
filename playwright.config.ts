import { defineConfig } from 'playwright/test';

const PORT = 4173;
export const BASE_URL = `http://127.0.0.1:${PORT}/`;

export default defineConfig({
  testDir: 'test',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    headless: true,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
