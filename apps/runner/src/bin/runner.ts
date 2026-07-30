/**
 * Volume runner entry point.
 *
 * Usage:
 *   pnpm --filter @warrant/runner runner
 *
 *   # a short series, without disturbing the Settler already running
 *   RUNNER_TARGET=6 RUNNER_SLASH_TARGET=1 pnpm --filter @warrant/runner runner
 *
 *   # resume an interrupted campaign: nothing special, the ledger is authoritative
 *   RUNNER_CAMPAIGN=hackathon pnpm --filter @warrant/runner runner
 *
 * The process is **interruptible**: SIGINT stops the openings, lets the warrants
 * in flight settle, publishes the final counter, then hands back control. A
 * second SIGINT exits immediately.
 */

import { loadEnv, run } from '../runner.js'

loadEnv()

run().catch((e: unknown) => {
  console.error(
    JSON.stringify({
      msg: 'runner: cannot start',
      error: e instanceof Error ? e.message : String(e),
    }),
  )
  process.exit(1)
})
