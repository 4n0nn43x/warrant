# Composition and hunt debrief

## What survived

| # | Finding | Severity | Status |
|---|---|---|---|
| 01 | I10 is enforced neither by the contract nor by its test | High | proven by execution, **fixed** |
| 02 | The `opener` alone holds a withdrawal authority | High | dedicated refuter → **holds**, not fixed |

## What died, and why it is useful to know

| Finding | Found by | Killed by |
|---|---|---|
| I5 falsifiable — bond trapped forever | **all 3 hunters** | `reclaim` has no upper time bound and is replayable indefinitely; a blacklist is revocable; `slash` before expiry drains to the beneficiary; and a blacklisted agent cannot move its own USDC anyway — marginal harm is nil |
| retroactive `feeBps` | 2 hunters | no fee quote is ever communicated to the agent; `MAX_FEE_BPS` is the only enforceable value; `treasury` is immutable; and the fuzzing handler **deliberately** calls `setFeeBps` between `open` and `honor` — reading at settlement is the specified semantics |
| `reclaim` more generous than `honor` | 1 hunter | the agent controls neither `duration`, nor `confirmations`, nor the timing of execution; the full refund is argued in the contract as anti-hostage-taking protection, and the inverse design would be worse |

**The most expensive lesson of this pass**: three independent hunters converged
on a false finding. Convergence is not proof — it is a shared bias when everyone
starts from the same recon. Only a refuter mandated to destroy saw that `reclaim`
was replayable.

## Chains attempted

**01 × 02 — confirmed, and 01 is the accelerant of 02.** Both are independently
exploitable, but once the roles are fused they remove the `MIN_DURATION` wait:
instead of opening and then waiting 901 seconds for a `reclaim`, a single key
opens and seizes **within the same transaction**. Fixing 01 does not close 02; it
only stretches its delay from 0 to 15 minutes.

**02 × absence of revocation — confirmed, and it makes things worse.**
`setOpener` allows a compromised opener to be revoked, but **already-open
warrants pay out regardless**: all three outflows pay an address frozen at open.
And since `owner` is neither transferable nor renounceable, a lost `owner` key
makes revocation impossible. The loss window is bounded not by a transaction but
by the propagation of a new payment address.

**02 × `beneficiary == treasury` — weak chain, but a real one.** The contract does
not forbid the beneficiary from being the treasury, and the operations tool
`packages/server/src/bin/open-warrant.ts:143` does exactly that
(`optional('WARRANT_TREASURY', agent)`). Verified onchain: warrant
`0x9d035197a8…`, slashed today, had `beneficiary == treasury`. So a slash really
did pay 100% of the bond to the protocol. I6 remains true to the letter — no fee
is taken — but the anti-perverse-incentive argument it carries before the jury no
longer holds on that path. The demo warrant itself (`0x23bedc5be1…`, beneficiary
`0x…bEEF`) is compliant: the documentation that cites it is accurate.

**Chains sought without success**: no griefing exploitable by a stranger
(`reclaim` only pays the registered agent, no bounty for the caller); no atomic
sequence (every outflow requires a role or ≥ 15 minutes, so the flash loan is
useless); no reentrancy (CEI respected line by line, USDC has no hook).

## Open lead, outside the contract's scope

`packages/core/src/policy.ts` says it itself: a checker that raises
`UnsupportedCheckError` "is not a guarantee, it is an automatic refund in
disguise". Since an action's category is **derived from the calldata**, the
question that remains is: can an agent steer its calldata toward a category whose
checker is unsupported, and thereby self-guarantee the refund? Part of the
problem was fixed today — the default postconditions no longer contain
`nonce_advanced` or `native_balance_delta`, both undecidable under sponsored
execution. The general shape deserves a dedicated pass on checker coverage.

## Submission observation

The 16 design documents — including the one stating invariants I1–I10 — live in
the **sibling** directory `../docs/`, outside the git repository. A jury cloning
the repo sees only `onboarding-teardown.md` and `transactions.md`. Two refuters
concluded that the source of the invariants "had never existed". If the
invariants are a submission argument, they must be in the repository.
