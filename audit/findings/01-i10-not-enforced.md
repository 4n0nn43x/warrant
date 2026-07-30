# 01 — Invariant I10 is enforced neither by the contract, nor by the test that certifies it

**Severity: High.**
**File:** `contracts/src/WarrantEscrow.sol`
**Commit:** `6194b68529d8c73b64a47ee98247bc2640887621`

## Summary

I10 states that the `opener` and the `settler` are two **distinct** roles, and
the README derives from it the project's central security guarantee:
*"Compromising the component that opens must not grant the power to seize."*

Not a single line of the contract enforces it. The constructor, `setOpener` and
`setSettler` never compare the two addresses. And the invariant test that claims
to verify it is structurally incapable of failing.

## The offending lines

```solidity
constructor(address token_, address treasury_, address opener_, address settler_, uint16 feeBps_) {
    if (feeBps_ > MAX_FEE_BPS) revert BadFee();
    // ← no comparison between opener_ and settler_
    token = IERC20(token_);
    treasury = treasury_;
    opener = opener_;
    settler = settler_;
```

```solidity
function setOpener(address next) external onlyOwner {
    emit OpenerChanged(opener, next);
    opener = next;              // ← no comparison with `settler`
}

function setSettler(address next) external onlyOwner {
    emit SettlerChanged(settler, next);
    settler = next;             // ← no comparison with `opener`
}
```

The repository's only safeguard is **offchain**, in
`contracts/script/Deploy.s.sol`, and its comment presents it as
"non-circumventable". It is circumventable: `setOpener` and `setSettler` never go
back through the script. **And the documented production flow takes precisely
that path** — `docs/transactions.md` § 3 describes `setOpener(walletKeeperHub)`
being executed after deployment to obtain gas sponsorship, which
`deployments/ethereum-sepolia.json` confirms (`openerAtDeploy` ≠ `opener`).

## The test that certifies without testing

`contracts/test/WarrantEscrow.invariant.t.sol`:

```solidity
function invariant_I10_RolesAreDistinctAndEnforced() public {
    assertTrue(opener != settler, "I10 viole : opener == settler");
```

But the handler draws each role from a separate pool:

```solidity
openerPool  = [makeAddr("opener.0"),  makeAddr("opener.1"),  makeAddr("opener.2")];
settlerPool = [makeAddr("settler.0"), makeAddr("settler.1"), makeAddr("settler.2")];
```

The two sets are **disjoint by construction**. The fuzzer cannot reach
`opener == settler`. The assertion passes 256 × 64 times without testing
anything. The test's other two branches — the settler cannot open, the opener can
neither honor nor slash — are real; it is the "distinct" clause that is hollow.

## Attack sequence

Attacker: holder of the `owner` key, or anyone who compromises it. The contract
has **neither ownership transfer nor renunciation**: `owner` is written exactly
once, in the constructor.

1. An agent settles its x402: 25 USDC arrive at the contract via a bare transfer.
   `totalLocked` is still 0 — that is the protocol's funding model.
2. `owner → setOpener(X)` then `owner → setSettler(X)`. No guard. I10 is dead.
3. `X → open(id, agent=X, beneficiary=X, bond=25e6, duration=15 min)` — the
   `balanceOf(this) >= totalLocked` check is satisfied **by the victim's funds**.
4. `X → slash(id, ...)` in the same transaction. The full `bond` goes to X.
5. The legitimate warrant can no longer be opened: `Underfunded()`.

## Impact

| | |
|---|---|
| Immediate extraction | `balanceOf(escrow) − totalLocked`, i.e. every x402 settlement that has landed and is not yet bound to a warrant |
| In steady state | step 2 freezes legitimate opening, hence **100% of all subsequent deposits** |
| Received by the treasury | **0** |

The last point is the most insidious: `slash` takes no fee (I6). The theft is
therefore **indistinguishable from a legitimate slash** in the protocol's
accounting — and I6, put forward to the jury as proof that no perverse incentive
exists, serves here as camouflage. A variant going through `honor` would yield
only `bond − fee` and would sprinkle the treasury: **I6 makes theft 2.5% more
profitable than legitimate use**.

## Executed proof

```
[PASS] test_constructorAcceptsIdenticalRoles()
  opener == settler accepte au deploiement: 0x9dF0C6b0...

[PASS] test_settersAllowFusingRoles()

[PASS] test_fusedRoleDrainsPendingBond()
  USDC voles a l'agent honnete: 25000000
  recu par la tresorerie du protocole: 0
```

## Fix, verified

```solidity
error RolesMustDiffer();

// constructor
if (opener_ == settler_) revert RolesMustDiffer();

// setOpener
if (next == settler) revert RolesMustDiffer();

// setSettler
if (next == opener) revert RolesMustDiffer();
```

Once applied, all three PoC tests fail on `RolesMustDiffer()`. The existing suite
(65 tests, 11 invariants) stays green.

**The invariant test must be fixed too**: as long as the pools are disjoint, it
will keep certifying a property it does not test. Drawing both roles from a
**shared pool** would make the assertion falsifiable.

## Anticipated objection

*"The `owner` is a trusted role; it shooting itself in the foot is not a
vulnerability."*

Three things rule that out. The contract has no way to revoke a compromised
`owner` — the compromise is terminal. Fusing the roles is a **plausible**
operational mistake rather than an improbable act of malice: a KeeperHub
organization has only one wallet, which the project documents as a constraint it
has to live with, so the temptation to use it for both roles is structural. And
above all, the guarantee advertised in the README becomes false: this is not "the
admin abuses its rights", it is "the documented security boundary does not
exist".
