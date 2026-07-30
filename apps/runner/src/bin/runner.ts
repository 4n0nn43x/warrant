/**
 * Point d'entrée du runner de volume.
 *
 * Usage :
 *   pnpm --filter @warrant/runner runner
 *
 *   # une série courte, sans toucher au Settler déjà lancé
 *   RUNNER_TARGET=6 RUNNER_SLASH_TARGET=1 pnpm --filter @warrant/runner runner
 *
 *   # reprendre une campagne interrompue : rien de spécial, le journal fait foi
 *   RUNNER_CAMPAIGN=hackathon pnpm --filter @warrant/runner runner
 *
 * Le processus est **interruptible** : SIGINT arrête les ouvertures, laisse les
 * mandats en vol se régler, publie le compteur final, puis rend la main. Un
 * second SIGINT sort immédiatement.
 */

import { loadEnv, run } from '../runner.js'

loadEnv()

run().catch((e: unknown) => {
  console.error(
    JSON.stringify({
      msg: 'runner: démarrage impossible',
      error: e instanceof Error ? e.message : String(e),
    }),
  )
  process.exit(1)
})
