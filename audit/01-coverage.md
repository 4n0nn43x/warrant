# OWASP SCS coverage check

A mandatory gate before writing a single report. For each of the ten categories:
where I looked, and what I conclude from it. A category answered with "did not
look" falls back to the scale in `no-false-negatives.md`.

| ID | Category | Where I looked | Conclusion |
|---|---|---|---|
| **SC01** | Access control | constructor `:90-103`, `setOpener` `:203-206`, `setSettler` `:208-211`, `onlyOwner` modifier `:81-84`, guards on `open`/`honor`/`slash`/`reclaim` | **Two findings.** I10 ("distinct roles") is enforced nowhere — proven by execution. And `open(agent=self) + reclaim` hands the `opener` a withdrawal authority the trust model never granted it. `owner` is neither transferable nor renounceable: a compromise is terminal. |
| **SC02** | Business logic | the ten declared invariants, attacked one by one | **Four broken or hollow**: I5 (falsifiable), I6 (true to the letter, economically circumventable), I8 (silent on *which* `feeBps`), I10 (nonexistent in the bytecode). **I1, I2, I3, I7 hold** and withstood three independent passes. |
| **SC03** | Oracle manipulation | the whole contract | **Not applicable**: no price, no oracle, no external source. The only price in the system is the `bond`, set offchain and frozen at open. |
| **SC04** | Flash-loan amplification | the three fund outflows | **No leverage.** `honor`/`slash` require the `settler` role; `reclaim` requires `block.timestamp > expiry`, hence ≥ 15 minutes. No atomic sequence exists. A flash loan deposited into the escrow would merely offer a surplus to steal, with no path back. **The relevant primitive here is the front-run**, not the flash loan: two findings rest on mempool ordering. |
| **SC05** | Input validation | the 8 parameters of `open` `:110-148` | Reported **through its consequence**, never bare. `agent = address(0)` traps the bond forever (`honor` and `reclaim` both revert on real USDC); `beneficiary = address(0)` makes the warrant unslashable and refunds the party at fault; `beneficiary = address(escrow)` manufactures a capturable surplus. The defect is not the missing `require`, it is the irrecoverable terminal state. |
| **SC06** | Unchecked external calls | the three `safeTransfer` at `:163`, `:164`, `:181`, `:197` | **The problem is the inverse of the category's name.** `SafeERC20` does revert on failure — nothing is "unchecked". The defect is that a transfer which reverts **blocks the state transition**: the *push* model makes a warrant's exit depend on the recipient's goodwill. A *pull* model would make I5 true in the sense it is written. |
| **SC07** | Arithmetic errors | `fee = (bond * feeBps) / 10_000` `:159`, `totalLocked +=/-=`, `expiry` | **Nothing exploitable.** Fee truncation favours the agent, never the protocol, and caps at 1 atomic unit (10⁻⁶ USDC) per warrant. The zero-fee threshold sits at `bond ≤ 39` atomic units, unreachable: `minBond` is 5,000,000 units. Dodging 1 USDC of fees would cost ~25,000 warrants. |
| **SC08** | Reentrancy | line-by-line CEI across the three outflows | **Holds.** Status is written before every transfer (`:157`, `:177`, `:193`); reentering on the same `id` dies on `NotOpen`. USDC has no receive hook. A **transient** inconsistency does exist between `totalLocked -= bond` and `honor`'s transfers, unexploitable with today's USDC — but swapping the order of the two transfers would make it disappear for free. |
| **SC09** | Overflows | `uint64 expiry`/`openedAt`, `uint16 feeBps`, `uint256 totalLocked` | **None reachable.** Solidity 0.8, checked arithmetic throughout. `uint64(block.timestamp) + duration`: 1.7e9 + ≤ 6.05e5 against a ceiling of 1.8e19. `totalLocked -= bond` cannot go below zero, guaranteed by I2/I3. |
| **SC10** | Proxy and upgradeability | the whole contract, plus `IERC20 public immutable token` `:34` | **No proxy in scope** — that is a deliberate design choice, and a good one. But the upgradeability risk is real and **displaced**: `immutable` freezes the token's *address*, not its *behaviour*, and native USDC is a proxy controlled by Circle. Were Circle to enable a transfer fee or a downward rebase, `balanceOf` would fall below `totalLocked` — I1 breaks, and the contract has no detection, no degraded mode, and no means of correction. |

## What the gate reveals about the pass itself

No category was left unanswered. Three — SC03, SC04, SC10 — are not applicable
or offer no leverage, and that is a result in itself: there will be nothing to
find by coming back to them.

The two productive categories are **SC01** and **SC02**, which is what the recon
led us to expect: a stateful escrow with neither oracle nor AMM concentrates its
defects in its roles and in the invariants it declares. It is also what
`historic-exploits.md` predicts for never-audited code — access control climbs
back to the top the moment nobody has yet grepped it.
