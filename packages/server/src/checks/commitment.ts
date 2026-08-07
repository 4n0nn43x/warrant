/**
 * `calldata_matches_commitment` — the executed transaction really is the
 * committed one.
 *
 * We rebuild the `ActionSpec` from the onchain transaction, normalise it, hash
 * it, and compare against the `actionHash` committed when the warrant was
 * opened.
 *
 * Without this check, committing to one action and executing another would be
 * undetectable: we would correctly classify a calldata that is not the one going
 * out on the chain (docs/07 § 2.10, docs/13 § 5). The Gateway adds it
 * unconditionally, and it cannot be removed.
 *
 * ⚠ The onchain transaction is not always the requested call. When KeeperHub
 * sponsors the gas, it goes through a forwarder and `tx.to` designates that
 * forwarder, not the target contract. So we unwrap before comparing — see
 * `forwarder.ts`. Without that step this check would fail on every sponsored
 * warrant, which would amount to a systematic unjust slash.
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
 * Normalised reconstruction: addresses lowercased, `value` as a decimal string,
 * calldata lowercased. Normalisation happens here so that `warrant-core`'s
 * canonicalisation never has to guess which fields are addresses.
 *
 * A contract creation (`to === null`) falls back to the zero address: the hash
 * will not match, which is exactly the verdict we want — no `ActionSpec` commits
 * to a deployment in v1.
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
      // `chainId` is absent from unprotected legacy transactions: we fall back to
      // the evaluation chain declared in the ConditionSpec.
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
