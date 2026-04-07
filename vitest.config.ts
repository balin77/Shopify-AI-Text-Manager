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
      // Only measure services + utils — routes/components require Shopify auth context
      // and cannot run in unit tests without full Remix/Shopify mock infrastructure.
      include: ['app/services/**', 'app/utils/**'],
      thresholds: {
        statements: 25,
        branches: 20,
        functions: 20,
        lines: 25,
      },
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './app'),
    },
  },
});
