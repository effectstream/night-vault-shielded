import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.unit.test.ts'],
    reporters: [
      'default',
      ...(process.env.GITHUB_ACTIONS === 'true'
        ? (['github-actions'] as const)
        : []),
    ],
  },
});
