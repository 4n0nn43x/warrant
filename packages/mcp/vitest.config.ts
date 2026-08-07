import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * `warrant-sdk` resolves to its sources rather than to `dist/`.
 *
 * Without this, every change to the SDK would require a `build` before the MCP
 * server's tests could run — and the shortest feedback loop is the one people
 * actually use.
 */
export default defineConfig({
  resolve: {
    alias: {
      'warrant-sdk': fileURLToPath(new URL('../sdk-ts/src/index.ts', import.meta.url)),
    },
  },
})
