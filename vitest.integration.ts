import { defineConfig } from 'vitest/config'

/*
 * Vitest applies VITEST_MAX_WORKERS after the config, over fileParallelism,
 * so a shell that exports it would run two files against one environment.
 */
delete process.env.VITEST_MAX_WORKERS

export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['./require-docker.ts'],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 180_000,
  },
})
