import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.pw.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5179',
    viewport: { width: 1024, height: 768 },
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: 'npx vite --config demo/vite.config.ts',
    url: 'http://localhost:5179/e2e.html',
    reuseExistingServer: true,
  },
});
