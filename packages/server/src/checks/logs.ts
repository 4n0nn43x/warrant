/**
 * Checks that read the logs of the action transaction: `event_emitted` and
 * `no_new_approvals`.
 *
 * Both read the receipt of the committed transaction, not a block range. That is
 * what makes them attributable: only what this transaction emitted can be held
 * against the agent.
 */

import { ERC20_EVENT_TOPIC_COUNT, TOPIC_APPROVAL } from './abi.js'
import {
  addressEquals,
  addressFromTopic,
  bigintFromData,
  lower,
  parseCount,
} from './compare.js'
import type {
  CheckEnv,
  CheckResult,
  EventEmittedCheck,
  NoNewApprovalsCheck,
} from './types.js'

export async function checkEventEmitted(
  check: EventEmittedCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const minCount = parseCount(check.minCount, 'event_emitted.minCount')

  let count = 0n
  for (const log of env.receipt.logs) {
    if (!addressEquals(log.address, check.address)) continue
    const topic0 = log.topics[0]
    if (!topic0) continue
    if (topic0.toLowerCase() !== check.topic0.toLowerCase()) continue
    count += 1n
  }

  return {
    kind: 'event_emitted',
    expected: `count(logs from ${lower(check.address)} with topic0=${lower(check.topic0)}) in tx ${env.txHash} gte ${minCount.toString()}`,
    observed: count.toString(),
    pass: count >= minCount,
  }
}

/**
 * `no_new_approvals` — no `Approval(owner, *, > 0)` in the transaction's logs.
 * Aimed at the Bankr vector: a call that silently hands out permissions along
 * the way.
 *
 * Decision the docs left open: **an empty `tokens` means "every token"**, not
 * "no token". The strict reading of § 2.9 is "no `Approval(owner, *, > 0)` event
 * appears in the logs"; an empty list that vacuously passed would be a
 * protection that disarms itself.
 *
 * An `Approval` resetting the allowance to zero is allowed: that is precisely
 * the revocation we want to permit.
 */
export async function checkNoNewApprovals(
  check: NoNewApprovalsCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const watchAll = !check.tokens || check.tokens.length === 0
  const offenders: string[] = []

  for (const log of env.receipt.logs) {
    if (!watchAll && !check.tokens.some((token) => addressEquals(log.address, token))) continue
    if (log.topics.length !== ERC20_EVENT_TOPIC_COUNT) continue // ERC-721: indexed tokenId
    const [topic0, ownerTopic, spenderTopic] = log.topics
    if (!topic0 || !ownerTopic || !spenderTopic) continue
    if (topic0.toLowerCase() !== TOPIC_APPROVAL.toLowerCase()) continue

    const owner = addressFromTopic(ownerTopic)
    if (!addressEquals(owner, check.owner)) continue

    const amount = bigintFromData(log.data)
    if (amount === 0n) continue // revocation: allowed

    offenders.push(
      `${lower(log.address)} -> spender ${addressFromTopic(spenderTopic)} = ${amount.toString()}`,
    )
  }

  const scope = watchAll ? 'any token' : check.tokens.map(lower).join(', ')

  return {
    kind: 'no_new_approvals',
    expected: `no Approval(owner=${lower(check.owner)}, *, > 0) in tx ${env.txHash} on [${scope}]`,
    observed:
      offenders.length === 0
        ? '0 new approvals'
        : `${offenders.length} new approvals: ${offenders.join('; ')}`,
    pass: offenders.length === 0,
  }
}
