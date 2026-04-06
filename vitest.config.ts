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
      include: [
        'app/**/*.{ts,tsx}',
        'src/**/*.ts',
      ],
      exclude: [
        'app/entry.client.tsx',
        'app/entry.server.tsx',
        '**/*.d.ts',
        '**/*.config.{ts,js}',
        '**/node_modules/**',
        'src/examples/**',
        'src/index.ts',
        'src/oauth-setup.ts',
      ],
      thresholds: {
        lines: 20,
        functions: 20,
        branches: 20,
        statements: 20,
      },
    },
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './app'),
    },
  },
});
