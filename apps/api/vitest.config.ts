import { defineConfig } from 'vitest/config';

// Tests run against their own database (see test/global-setup.ts), never the development one.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://erp:erp_local_only@localhost:54329/erp_test';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    fileParallelism: false,
    globalSetup: ['test/global-setup.ts'],
    env: { DATABASE_URL: TEST_DATABASE_URL },
  },
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
});
