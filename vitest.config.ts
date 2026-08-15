import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,apps}/*/src/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
