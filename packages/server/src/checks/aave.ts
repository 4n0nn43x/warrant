/**
 * `aave_health_factor` — santé d'une position Aave V3 au bloc d'évaluation.
 *
 * `Pool.getUserAccountData(user)` retourne
 * `(totalCollateralBase, totalDebtBase, availableBorrowsBase,
 *   currentLiquidationThreshold, ltv, healthFactor)`.
 * Le `healthFactor` est le **6e** élément, en 1e18 — `1500000000000000000` = 1,5.
 *
 * Cas limite : une position sans dette rend `type(uint256).max`. La comparaison
 * `gte` reste correcte en `bigint`, ce qui ne serait pas le cas en `number`.
 */

import { AAVE_HEALTH_FACTOR_INDEX, aavePoolAbi } from './abi.js'
import { compare, lower, parseDecimal } from './compare.js'
import { read } from './errors.js'
import type { AaveHealthFactorCheck, CheckEnv, CheckResult } from './types.js'

export async function checkAaveHealthFactor(
  check: AaveHealthFactorCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const expected = parseDecimal(check.value, 'aave_health_factor.value')

  const data = await read(
    `getUserAccountData(${lower(check.pool)}, ${lower(check.user)}) @ ${env.evalBlock}`,
    () =>
      env.client.readContract({
        address: check.pool,
        abi: aavePoolAbi,
        functionName: 'getUserAccountData',
        args: [check.user],
        blockNumber: env.evalBlock,
      }),
  )

  const observed = data[AAVE_HEALTH_FACTOR_INDEX]

  return {
    kind: 'aave_health_factor',
    expected: `healthFactor(pool=${lower(check.pool)}, user=${lower(check.user)}) @ block ${env.evalBlock} ${check.op} ${expected.toString()} (1e18)`,
    observed: observed.toString(),
    pass: compare(observed, check.op, expected),
  }
}
