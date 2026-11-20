import { defineConfig } from 'playwright/test';

// Local-only (never run by CI): the offline end-to-end proof and the Devanagari gate test, in installed Google Chrome (channel 'chrome', no
// browser download). There is no webServer: the specs serve dist/ themselves under /dockit/ (a server that 404s every other path), so run
//   node scripts/assemble-deps.mjs --siblings .. --allow-dirty && npm run build
// first. They launch their own persistent contexts (Chrome profile folders named chrome-profile-*) so they can restart Chrome on the same profile.
export default defineConfig({
  testDir: 'test',
  testMatch: /(e2e|gate|failfast-crash)\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  reporter: [['list']],
  expect: { timeout: 30_000 },
  // no action may wait forever: a locator that never resolves fails after a minute
  use: { channel: 'chrome', headless: true, actionTimeout: 60_000 },
});
