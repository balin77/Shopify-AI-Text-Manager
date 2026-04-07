/// <reference types="vitest" />
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/shopify_test',
      SHOPIFY_API_KEY: 'test-api-key',
      SHOPIFY_API_SECRET: 'test-api-secret',
      ENCRYPTION_KEY: 'test-encryption-key-32-chars!!',
    },
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      // Scope to unit-testable code only (services + utils).
      // Routes and React components require Shopify auth context / browser
      // environment and are covered by integration/E2E tests, not unit tests.
      include: [
        'app/services/**/*.ts',
        'app/utils/**/*.ts',
        'src/services/**/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        '**/*.config.{ts,js}',
        '**/node_modules/**',
        'src/examples/**',
      ],
      thresholds: {
        // Achievable with current test suite (~20 % statements across
        // services/utils).  Raise incrementally as new tests are added.
        lines: 15,
        functions: 10,
        branches: 8,
        statements: 15,
      },
    },
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './app'),
    },
  },
});
