import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * `@warrant/sdk` est résolu vers ses sources plutôt que vers `dist/`.
 *
 * Sans cela, chaque modification du SDK exigerait un `build` avant de pouvoir
 * lancer les tests du serveur MCP — la boucle de retour la plus courte est
 * celle qu'on utilise réellement.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@warrant/sdk': fileURLToPath(new URL('../sdk-ts/src/index.ts', import.meta.url)),
    },
  },
})
