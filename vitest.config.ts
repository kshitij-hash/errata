import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // apps/web is a Next app: its units live in lib/, not src/
    include: ['{packages,apps}/*/src/**/*.spec.ts', 'apps/web/lib/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
