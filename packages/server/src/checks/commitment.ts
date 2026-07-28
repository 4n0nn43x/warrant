/**
 * `calldata_matches_commitment` — la transaction exécutée est bien celle
 * engagée.
 *
 * On reconstruit l'`ActionSpec` depuis la transaction onchain, on la normalise,
 * on la hache, et on compare à l'`actionHash` engagé à l'ouverture du mandat.
 *
 * Sans ce vérificateur, engager une action et en exécuter une autre serait
 * indétectable : on classerait correctement un calldata qui n'est pas celui qui
 * part sur la chaîne (docs/07 § 2.10, docs/13 § 5). Il est ajouté d'office par
 * le Gateway et n'est pas retirable.
 *
 * ⚠ La transaction onchain n'est pas toujours l'appel demandé. Quand KeeperHub
 * sponsorise le gas, elle passe par un forwarder et `tx.to` désigne celui-ci,
 * pas le contrat cible. On décapsule donc avant de comparer — voir
 * `forwarder.ts`. Sans cette étape, ce check échouerait sur chaque mandat
 * sponsorisé, ce qui produirait une saisie injuste systématique.
 */

import { lower } from './compare.js'
import { unwrapForwarder } from './forwarder.js'
import type {
  ActionSpec,
  CalldataMatchesCommitmentCheck,
  CheckEnv,
  CheckResult,
  Hex,
} from './types.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex

export async function checkCalldataMatchesCommitment(
  check: CalldataMatchesCommitmentCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const { spec: actionSpec, viaForwarder } = reconstructActionSpec(env)
  const observed = env.hashAction(actionSpec)
  const expected = lower(check.actionHash)
  const via = viaForwarder ? ', via forwarder' : ''

  return {
    kind: 'calldata_matches_commitment',
    expected: `actionHash(target, value, calldata, chainId, registryRef) of tx ${env.txHash} eq ${expected}`,
    observed: `${lower(observed)} (target=${actionSpec.target}, value=${actionSpec.value}, calldata=${truncate(actionSpec.calldata)}, chainId=${actionSpec.chainId}${via})`,
    pass: lower(observed) === expected,
  }
}

/**
 * Reconstruction normalisée : adresses en minuscules, `value` en chaîne
 * décimale, calldata en minuscules. La normalisation est faite ici pour que la
 * canonicalisation de `@warrant/core` n'ait pas à deviner quels champs sont des
 * adresses.
 *
 * Une création de contrat (`to === null`) tombe sur l'adresse nulle : le hash
 * ne correspondra pas, ce qui est le verdict recherché — aucune `ActionSpec`
 * n'engage un déploiement en v1.
 */
export function reconstructActionSpec(env: CheckEnv): {
  spec: ActionSpec
  viaForwarder: boolean
} {
  const tx = env.transaction
  const call = unwrapForwarder({
    to: tx.to ?? null,
    value: tx.value,
    input: (tx.input ?? '0x') as Hex,
  })

  return {
    spec: {
      version: 1,
      // `chainId` est absent des transactions legacy non protégées : on retombe
      // sur la chaîne d'évaluation déclarée dans la ConditionSpec.
      chainId: tx.chainId ?? env.chainId,
      target: lower(call.target ?? ZERO_ADDRESS),
      value: call.value.toString(),
      calldata: lower(call.calldata ?? '0x'),
      registryRef: lower(env.registryRef ?? ZERO_HASH),
    },
    viaForwarder: call.viaForwarder,
  }
}

function truncate(data: string): string {
  return data.length <= 26 ? data : `${data.slice(0, 26)}…`
}
