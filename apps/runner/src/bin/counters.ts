/**
 * Public, read-only counter — what the dashboard and the jury read.
 *
 * Split out from the runner by necessity, not by taste: the number has to be
 * verifiable **without** running the runner, and by someone who has neither the
 * keys nor any desire to launch a campaign. This binary opens nothing, signs
 * nothing, touches no private key: it reads the ledger to learn the list of
 * warrants, then the chain to learn their status. Both sources are ones anyone
 * can replay.
 *
 * Usage:
 *   pnpm --filter @warrant/runner counters            # readable table + JSON
 *   pnpm --filter @warrant/runner counters -- --json  # JSON only, for a pipe
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Address } from 'warrant-core'
import { publicClientFor } from '../chain.js'
import { address, integer, optional, required } from '../env.js'
import { computeCounters, openLedger, type Tally } from '../ledger.js'
import { loadEnv } from '../runner.js'

loadEnv()

function line(label: string, value: string | number): string {
  return `  ${label.padEnd(28, '.')} ${value}`
}

function render(title: string, t: Tally): string {
  const settled = t.honored + t.slashed
  return [
    title,
    line('warrants opened (total)', t.opened),
    line('  honored', t.honored),
    line('  slashed', t.slashed),
    line('  reclaimed (expired)', t.reclaimed),
    line('  still open', t.open),
    line('settled', settled),
    line('slash rate', `${(t.slashRateBps / 100).toFixed(2)} %`),
    line('capital locked', `${t.locked_usdc} USDC`),
    line('capital destroyed (slashes)', `${t.destroyed_usdc} USDC`),
    line('fees paid (honored)', `${t.fees_usdc} USDC`),
    line('capital returned to agent', `${t.refunded_usdc} USDC`),
  ].join('\n')
}

async function main(): Promise<void> {
  const jsonOnly = process.argv.includes('--json')
  const chainId = integer('WARRANT_ESCROW_CHAIN_ID', 84532)
  const escrow = address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS')) as Address
  const repoRoot = resolve(optional('RUNNER_REPO_ROOT', new URL('../../../../', import.meta.url).pathname))
  const client = publicClientFor(
    chainId,
    optional('WARRANT_ESCROW_RPC', 'https://sepolia.base.org'),
  )
  const campaign = optional('RUNNER_CAMPAIGN', 'hackathon')
  const ledger = openLedger(
    resolve(repoRoot, optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl')),
    campaign,
  )

  const counters = await computeCounters({ ledger, client, escrow, chainId, campaign })

  if (!jsonOnly) {
    console.error(
      [
        '',
        `WARRANT — onchain counter  (chainId ${chainId}, escrow ${escrow})`,
        `computed at ${counters.at}`,
        '',
        render(`Campaign "${campaign}"`, counters.campaignTally),
        '',
        render('All warrants in the ledger', counters.total),
        counters.unknown > 0
          ? `\n  ⚠ ${counters.unknown} ledger warrant(s) not found onchain — ledger out of sync`
          : '',
        '',
      ].join('\n'),
    )
  }
  console.log(JSON.stringify(counters, null, 2))

  // This binary writes the file too: that is what lets a dashboard stay up to
  // date while the runner is not running.
  const out = resolve(repoRoot, optional('RUNNER_COUNTERS_FILE', '.warrant/counters.json'))
  mkdirSync(dirname(out), { recursive: true })
  const tmp = `${out}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(counters, null, 2)}\n`, 'utf8')
  renameSync(tmp, out)
}

main().catch((e: unknown) => {
  console.error(
    JSON.stringify({ msg: 'counters: failed', error: e instanceof Error ? e.message : String(e) }),
  )
  process.exit(1)
})
