/**
 * Dispatch over the closed catalogue of checks (docs/07 § 2).
 *
 * The catalogue is **finite and enumerated**. A `kind` outside the list throws
 * `UnknownCheckKindError` — it is never interpreted, never ignored, and never
 * yields a `pass` by default.
 */

import { checkAaveHealthFactor } from './aave.js'
import { checkCalldataMatchesCommitment } from './commitment.js'
import {
  checkErc20Allowance,
  checkErc20Balance,
  checkErc20BalanceDelta,
} from './erc20.js'
import { UnknownCheckKindError } from './errors.js'
import { checkEventEmitted, checkNoNewApprovals } from './logs.js'
import { checkNativeBalanceDelta } from './native.js'
import { checkNonceAdvanced } from './nonce.js'
import { checkStaticcallResult } from './staticcall.js'
import type { Check, CheckEnv, CheckKind, CheckResult } from './types.js'

export const CHECK_KINDS: readonly CheckKind[] = [
  'erc20_allowance',
  'erc20_balance',
  'erc20_balance_delta',
  'native_balance_delta',
  'aave_health_factor',
  'staticcall_result',
  'event_emitted',
  'nonce_advanced',
  'no_new_approvals',
  'calldata_matches_commitment',
]

export function isKnownKind(kind: string): kind is CheckKind {
  return (CHECK_KINDS as readonly string[]).includes(kind)
}

export async function runCheck(check: Check, env: CheckEnv): Promise<CheckResult> {
  switch (check.kind) {
    case 'erc20_allowance':
      return checkErc20Allowance(check, env)
    case 'erc20_balance':
      return checkErc20Balance(check, env)
    case 'erc20_balance_delta':
      return checkErc20BalanceDelta(check, env)
    case 'native_balance_delta':
      return checkNativeBalanceDelta(check, env)
    case 'aave_health_factor':
      return checkAaveHealthFactor(check, env)
    case 'staticcall_result':
      return checkStaticcallResult(check, env)
    case 'event_emitted':
      return checkEventEmitted(check, env)
    case 'nonce_advanced':
      return checkNonceAdvanced(check, env)
    case 'no_new_approvals':
      return checkNoNewApprovals(check, env)
    case 'calldata_matches_commitment':
      return checkCalldataMatchesCommitment(check, env)
    default:
      throw new UnknownCheckKindError((check as { kind: string }).kind)
  }
}

export * from './abi.js'
export * from './commitment.js'
export * from './compare.js'
export * from './erc20.js'
export * from './errors.js'
export * from './native.js'
export type * from './types.js'
