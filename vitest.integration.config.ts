import { configDefaults, defineConfig } from 'vitest/config';

const env = process.env.MN_ENV ?? 'undeployed';
const isHosted = env !== 'undeployed';
// Up to 3 attempts by default: transient wallet-sync / DUST-funding races are
// a known flaky tail on a freshly booted local stack.
const retry = Number(process.env.MN_TEST_RETRY ?? 2);

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.unit.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    testTimeout: isHosted ? 10 * 60_000 : 5 * 60_000,
    hookTimeout: isHosted ? 20 * 60_000 : 10 * 60_000,
    retry,
    // The docker stack is single-client: run files serially in forked workers.
    pool: 'forks',
    fileParallelism: false,
    reporters: [
      'default',
      ['json', { outputFile: 'reports/vitest-results.json' }],
      ...(process.env.GITHUB_ACTIONS === 'true' ? (['github-actions'] as const) : []),
    ],
  },
});
