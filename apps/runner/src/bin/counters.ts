/**
 * Compteur public, en lecture seule — ce que le dashboard et le jury lisent.
 *
 * Séparé du runner par nécessité, pas par goût : le chiffre doit être vérifiable
 * **sans** faire tourner le runner, et par quelqu'un qui n'a ni les clés ni
 * l'envie de lancer une campagne. Ce binaire n'ouvre rien, ne signe rien, ne
 * touche à aucune clé privée : il lit le journal pour connaître la liste des
 * mandats, puis la chaîne pour connaître leur statut. Les deux sources sont
 * celles que n'importe qui peut rejouer.
 *
 * Usage :
 *   pnpm --filter @warrant/runner counters            # tableau lisible + JSON
 *   pnpm --filter @warrant/runner counters -- --json  # JSON seul, pour un pipe
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Address } from '@warrant/core'
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
    line('mandats ouverts (total)', t.opened),
    line('  honorés', t.honored),
    line('  saisis', t.slashed),
    line('  réclamés (expirés)', t.reclaimed),
    line('  encore ouverts', t.open),
    line('réglés', settled),
    line('taux de saisie', `${(t.slashRateBps / 100).toFixed(2)} %`),
    line('capital immobilisé', `${t.locked_usdc} USDC`),
    line('capital détruit (saisies)', `${t.destroyed_usdc} USDC`),
    line('frais payés (honorés)', `${t.fees_usdc} USDC`),
    line('capital rendu à l’agent', `${t.refunded_usdc} USDC`),
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
        `WARRANT — compteur onchain  (chainId ${chainId}, escrow ${escrow})`,
        `calculé le ${counters.at}`,
        '',
        render(`Campagne « ${campaign} »`, counters.campaignTally),
        '',
        render('Tous mandats du journal', counters.total),
        counters.unknown > 0
          ? `\n  ⚠ ${counters.unknown} mandat(s) du journal introuvables onchain — journal désynchronisé`
          : '',
        '',
      ].join('\n'),
    )
  }
  console.log(JSON.stringify(counters, null, 2))

  // Le fichier est écrit aussi par ce binaire : c'est ce qui permet à un
  // dashboard de rester à jour quand le runner ne tourne pas.
  const out = resolve(repoRoot, optional('RUNNER_COUNTERS_FILE', '.warrant/counters.json'))
  mkdirSync(dirname(out), { recursive: true })
  const tmp = `${out}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(counters, null, 2)}\n`, 'utf8')
  renameSync(tmp, out)
}

main().catch((e: unknown) => {
  console.error(
    JSON.stringify({ msg: 'counters: échec', error: e instanceof Error ? e.message : String(e) }),
  )
  process.exit(1)
})
