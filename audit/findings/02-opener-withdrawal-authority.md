# 02 — The `opener` alone holds a withdrawal authority, without the settler or the owner

**Severity: High.**
**File:** `contracts/src/WarrantEscrow.sol`
**Commit:** `6194b68529d8c73b64a47ee98247bc2640887621`

Found independently by two hunters, then handed to a refuter tasked with
destroying it through the "reachability and trust model" lens. **It survived**,
with three corrections that this report incorporates.

## Summary

`open()` lets the `opener` freely name the `agent` and the `beneficiary`, with no
verified link to whoever actually paid. Yet those two fields are the recipients of
**all three** of the contract's fund outflows. The `opener` can therefore award
itself any free balance, alone, without the `settler`, without the `owner`,
without capital.

In production, the `opener` is the **KeeperHub** organization wallet — a third
party, which `docs/transactions.md` § 3 describes as *organization-scoped, not
per-user*, hence shared.

## The offending lines

```solidity
function open(
    bytes32 id,
    address agent,          // ← never validated, never tied to the payer
    address beneficiary,    // ← never validated
    uint256 bond,
    bytes32 conditionHash,
    bytes32 actionHash,
    bytes32 fundingRef,     // ← stored, emitted, NEVER READ BACK by any function
    uint64 duration
) external {
    if (msg.sender != opener) revert NotOpener();
    ...
    totalLocked += bond;
    if (token.balanceOf(address(this)) < totalLocked) revert Underfunded();
```

`fundingRef` is documented as "the audit trail linking the bond to the warrant".
It is an opaque `bytes32` that no line of the contract reads, constrains, or
requires to be unique. The funding check is **purely aggregate**: it is satisfied
by anybody's money.

```solidity
function reclaim(bytes32 id) external {
    // deliberately permissionless
    ...
    token.safeTransfer(w.agent, amount);   // ← `agent` chosen by the opener
}
```

## Attack sequence

Attacker: holder of the `opener` key. No collusion, no capital.

1. A client settles in x402. Settlement transfers the USDC **to the contract**
   (`WARRANT_PAY_TO` is the escrow's address, forced by the
   `balanceOf(this) >= totalLocked` check). `totalLocked` is still 0.
2. `opener → open(id, agent=thief, beneficiary=thief, bond=<amount deposited>,
   duration=MIN_DURATION)`. Every check passes.
3. The `settler` does nothing: no KeeperHub execution corresponds to this warrant,
   so it has nothing to judge.
4. `t + 901 s`: **anyone** calls `reclaim(id)` — the thief will do fine. Full
   `bond`, **no fee**.

As a bonus: the legitimate opening this payment was funding then reverts with
`Underfunded()`. The victim has paid, has no warrant, and has no recourse — there
is no sweep, no refund, no cancellation.

## Impact

| | |
|---|---|
| Exact bound | `balanceOf(escrow) − totalLocked` **at the instant of the `open`** |
| Bonds already locked | **protected** — I1 holds, one unit more reverts with `Underfunded` |
| In steady state | every x402 settlement transits through the free balance before its `open`: **100% of every incoming payment**, indefinitely, until the `opener` is rotated |
| Received by the treasury | 0 |
| Capital required | 0 |
| Latency | 901 seconds |

## What the refuter corrected

**1. "I9 locks the theft down" is false.** The settler *can* slash before expiry.
What makes the defence inoperative is simpler and more serious: `slash` pays
`w.beneficiary`, `honor` and `reclaim` pay `w.agent` — **all three outflows pay an
address chosen by the opener**. There is no defensive path. Even with `setOpener`
revoked, the already-open warrant pays out regardless.

**2. "Drains the contract" was imprecise.** The bound is the free balance, not
`totalLocked`. The steady-state formulation, however, remains exact.

**3. No shorter path.** The thief holds only the `opener`; it must wait
`MIN_DURATION`. Those 15 minutes are a floor, not a window of defence — see below.

## Why nobody would notice the anomaly

`packages/server/src/daemon.ts` treats an onchain warrant absent from the journal
as `{kind: 'deferred', reason: "aucune spec au journal…"}`. No path leads to
`slash`. And the operator cannot tell it apart from a normal case: the Gateway
opens onchain **before** writing the journal, so "deferred, no spec" is the
expected transient state of *every* legitimate warrant. The operator output is
nothing but a `deferred: N` counter per tick — no alert, no identifier. A
fraudulent warrant drowns exactly in the noise that was planned for.

## Two project claims this falsifies

- `README.md`: *"I10 — Compromising the component that opens must not grant the
  power to seize."*
- `docs/transactions.md` § 3: *"settlement is the sensitive operation: it is the
  only privilege that moves funds to a third party."*

`open` also moves funds to a third party, with 15 minutes of latency. And the
project **acted** on that belief: it deliberately placed the `opener` on KeeperHub
infrastructure *because it believed that role carried no funds*, while keeping the
`settler` "outside the execution infrastructure". The architectural decision rests
on a property that does not exist.

Your own test `test_NoEmergencyWithdrawExists` asserts that no withdrawal exists.
`open(agent=self) + reclaim` **is** a withdrawal function, on a delay.

## Fix

No simple guard closes this — it is a design defect, not a missing `require`. Two
directions consistent with the architecture:

1. **Tie `agent` to the payer observed onchain.** Make `fundingRef` something
   other than a decorative field: a `fundingRef → (payer, amount, consumed)`
   mapping fed by a deposit function, with `open` refusing if `agent` ≠ payer or
   if the amount does not cover the `bond`.
2. **Require the agent's signature** over the warrant parameters, verified inside
   `open`. The opener returns to being a mere relay and can no longer name a
   recipient the agent has not approved.

In the very short term and without redeployment, a partial mitigation exists on
the operations side: watch for `WarrantOpened` events whose `id` is absent from
the journal and **slash before expiry** to a controlled beneficiary. That turns
theft into destruction — which is less bad, without being good.
