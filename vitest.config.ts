import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests cover the pure logic only: citation validation, chunking,
    // structured-output parsing, and the domain-pack contract. Anything that
    // needs D1, R2, Vectorize, or Mistral is covered by the evaluation harness
    // (`npm run eval`) against the live stack, because mocking those would
    // test the mocks rather than the integration.
    include: ['src/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
