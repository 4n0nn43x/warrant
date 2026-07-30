/**
 * `aave_health_factor` — health of an Aave V3 position at the evaluation block.
 *
 * `Pool.getUserAccountData(user)` returns
 * `(totalCollateralBase, totalDebtBase, availableBorrowsBase,
 *   currentLiquidationThreshold, ltv, healthFactor)`.
 * The `healthFactor` is the **6th** element, scaled by 1e18 —
 * `1500000000000000000` = 1.5.
 *
 * Edge case: a position with no debt returns `type(uint256).max`. The `gte`
 * comparison stays correct in `bigint`, which would not be true in `number`.
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
