# Recon — WarrantEscrow

**Audited commit**: `6194b68529d8c73b64a47ee98247bc2640887621`
**Date**: 2026-07-29

## Platform

**None.** This is not a contest: it is the project's own contract, never audited
by a third party. Methodological consequence: we weight by
`historic-exploits.md` (actual losses) rather than by contest frequency. Access
control and reentrancy, which sit at the bottom of contest rankings because
everyone greps for them first, rise to the top here: nobody has looked for them
in this code yet.

## Scope

`contracts/src/WarrantEscrow.sol` — 226 lines. A single contract, no proxy, no
in-house library, no inheritance outside OpenZeppelin (`IERC20`, `SafeERC20`).

## Deterministic tooling

- **Slither**: 17 results, all of them `pragma` noise on the OpenZeppelin
  dependencies, save one — `owner should be immutable`. That is correct, and it
  says something: **there is no ownership transfer at all**.
- **Coverage**: **100%** of lines, statements, branches and functions. No
  untested path to exploit as a lead. What remains is protocol logic, which
  coverage cannot see.
- 65 Foundry tests, 11 of them stateful fuzzing invariants.

## Declared invariants — the assertions to attack

Source: `docs/06-contrat-escrow.md` § 3.

| # | Statement |
|---|---|
| I1 | `token.balanceOf(this) >= totalLocked` at all times |
| I2 | A warrant leaves `Open` exactly once |
| I3 | From `Open`, only `Honored`, `Slashed`, `Reclaimed` are reachable |
| I4 | `conditionHash` and `actionHash` immutable after `open` |
| I5 | After `expiry`, `reclaim` **always** succeeds for an `Open` warrant |
| I6 | `slash` takes **no** fee |
| I7 | `feeBps <= MAX_FEE_BPS` permanently |
| I8 | `honor(id)` transfers exactly `bond − bond·feeBps/10000` to `agent` |
| I9 | `honor` and `slash` revert as soon as `block.timestamp > expiry` |
| I10 | Only the `opener` can `open`, only the `settler` can `honor`/`slash`, and **the two roles are distinct** |

I6 and I9 are put forward to the jury: breaking them costs double.

## Actors and trust

| Role | May call | Trust granted |
|---|---|---|
| `owner` | `setOpener`, `setSettler`, `setFeeBps` | not to reassign the roles to itself. No ownership transfer, no renunciation |
| `opener` | `open` | to supply parameters faithful to the warrant that was paid for. In production: the **KeeperHub** organization wallet, hence a third party |
| `settler` | `honor`, `slash` | to judge honestly — the only privilege that sends funds to a third party |
| `agent` | nothing | recipient of `honor` and `reclaim` |
| `beneficiary` | nothing | recipient of `slash` |
| `treasury` | nothing | recipient of fees, immutable |
| anyone | `reclaim` | permissionless, by design |

## Value flow — the main surface

**Funds arrive through a bare ERC20 transfer.** There is no deposit function:
x402 settlement transfers the USDC straight to the contract, then the `opener`
calls `open`. The contract never checks *who funded what*, only an aggregate:

```solidity
totalLocked += bond;
if (token.balanceOf(address(this)) < totalLocked) revert Underfunded();
```

No per-warrant accounting — a deliberate choice ("USDC is fungible"). That is
where to look.

| Outflow | To | Amount | Fee |
|---|---|---|---|
| `honor` | `treasury` then `agent` | `fee`, then `bond - fee` | yes |
| `slash` | `beneficiary` | full `bond` | **no** (I6) |
| `reclaim` | `agent` | full `bond` | no |

**No sweep function.** Any USDC beyond `totalLocked` is unrecoverable by
construction.

## State-changing entry points

| Function | Access | Note |
|---|---|---|
| `open` | `opener` | 8 parameters, **no zero-address check** |
| `honor` | `settler` | window closed after `expiry` |
| `slash` | `settler` | same, plus an unbounded `string reason` |
| `reclaim` | **none** | only after `expiry` |
| `setOpener` / `setSettler` | `onlyOwner` | |
| `setFeeBps` | `onlyOwner` | capped at `MAX_FEE_BPS` |

## Classes retained

`protocol-invariants` (ten written invariants — that is the heart),
`access-control` (three roles, I10), `token-integration` (bare funding, no
sweep), `dos-griefing` (I5 and I9 are availability properties),
`withdrawals-redemptions` (permissionless `reclaim`), `fees` (I6/I7/I8 and *when*
`feeBps` is read), `reentrancy`, `math-casting`.

Ruled out: AMM, shares, oracle, lending, governance, rewards, NFT, cross-chain,
upgradeability (no proxy), signatures (none in this contract), Solana.
