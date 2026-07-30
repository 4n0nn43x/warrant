# Real transactions

All verifiable. None is simulated, none is a mockup.

> **Deployment status.** What follows runs on **Ethereum Sepolia**, with a test
> USDC. This is a **development** deployment: it proves the full cycle works
> onchain. The submission's target is **Base (8453)** with Circle's native USDC,
> where the contract will be redeployed — the hackathon explicitly values mainnet,
> and a final submission on testnet would be a weakness accepted for nothing.

---

## 1. Execution through KeeperHub

The first call this project executed through KeeperHub, on **Base Sepolia**. It is
the demo's allowance-revocation scenario: `approve(spender, 0)`.

| | |
|---|---|
| Transaction | [`0xaf65a4e6…4d315`](https://sepolia.basescan.org/tx/0xaf65a4e68a3a567729c95c3b2fef324612d70544aae930f2f7ae09a43cb4d315) |
| KeeperHub `executionId` | `w077usw3ru11uwafb2yd1` |
| Block | 44736245 |
| Gas | 97,164, **sponsored** |
| Call | `approve(0x…dEaD, 0)` on Base Sepolia USDC |

**What this transaction taught the project.** It went through even though the
organization's wallet is empty on all 20 chains — sponsorship works. But above all
it revealed that a sponsored transaction **does not look like what was asked for**:

| | Expected | Actual onchain |
|---|---|---|
| `tx.from` | org wallet | relayer `0x6331eb45…` |
| `tx.to` | USDC `0x036cbd…` | forwarder `0x5aF5194B…` |
| `tx.input` | `approve(…)` | `execute(address,address,uint256,bytes)` |

Without unwrapping that envelope, `calldata_matches_commitment` would fail on
**every** sponsored warrant, and the system would seize bonds wrongly and
systematically. The fix is in
[`packages/server/src/checks/forwarder.ts`](../packages/server/src/checks/forwarder.ts),
and its tests replay the exact bytes of this transaction.

---

## 2. A full warrant cycle — Ethereum Sepolia

Contract: [`0xadDC715B…de12`](https://sepolia.etherscan.io/address/0xadDC715B79Cb972d3a7f0dce5998CC141CaAde12)
· `feeBps` = 250 (2.5%) · `MIN_DURATION` = 900 s

### Honored warrant

| Step | Transaction |
|---|---|
| Bond paid into the escrow | [`0xa62c736c…896d`](https://sepolia.etherscan.io/tx/0xa62c736c2bdffe77575ff8807053d792f1ae39c31ba41fb28afeb2c65f31896d) |
| `open` by the **opener** | [`0x03a4cd54…4519`](https://sepolia.etherscan.io/tx/0x03a4cd54f97fa66f7f6464f0f4168d8623ad1cda47c1f695d6b9417a1b3d4519) |
| `honor` by the **settler** | [`0x77066307…2721`](https://sepolia.etherscan.io/tx/0x77066307716e5626c57871cc78890713cd4035d6fc34663c6022466cbc682721) |

`warrantId` `0x07b03947…7dc3`. Decoded `WarrantHonored` event:
**`refunded` = 24.375 USDC, `fee` = 0.625 USDC** — exactly `bond − bond·250/10000`.
`totalLocked` returns to 0.

### Slashed warrant

This is the one that counts. A guardrail that blocks produces no transaction, hence
no proof; here the failure becomes a verifiable onchain artifact.

| Step | Transaction |
|---|---|
| `open` | included in the same batch |
| **`slash`** by the settler | [`0x3cecf857…bb21`](https://sepolia.etherscan.io/tx/0x3cecf857ae09d6bcf85927057cc99bcc4d5b446bb1d4212d2f541686750abb21) |

The reason recorded onchain, as anyone will read it:

```
erc20_balance_delta: attendu >=-1000000000, observé -9000000000 |
erc20_balance(allowed_dest): attendu >=1000000000, observé 0
```

**Invariant I6 verified onchain**: the beneficiary receives the **full 25 USDC**,
the protocol treasury receives **zero**. A slash earns Warrant nothing — that is
what eliminates the perverse-incentive objection, and it is not merely written in a
test, it is observable on the chain.

---

## 3. The escrow driven by KeeperHub — and the limit we found there

The question asked: can the `open` / `honor` / `slash` calls go through KeeperHub,
and therefore be sponsored? That would decide how the whole volume runner is
funded.

**Answer: yes for one role, and one only.**

| Step | Result |
|---|---|
| `setOpener(walletKeeperHub)` | [`0x…`](https://sepolia.etherscan.io/address/0xadDC715B79Cb972d3a7f0dce5998CC141CaAde12) — the opener becomes the organization's wallet |
| **`open` through KeeperHub** | [`0x12ad7c02…6374`](https://sepolia.etherscan.io/tx/0x12ad7c029e386fb20e01336d93967ecca431f9917a9204301de3b0b74d2d6374) — **`sponsored: true`**, 275,904 gas, warrant `Open` onchain |
| `honor` by the local settler | [`0x42966aee…d897`](https://sepolia.etherscan.io/tx/0x42966aee484a7655c0d9e673609ebbf9cb0e6e3ca5cdc0855d66747ae8abd897) |

Opening a warrant is therefore **free in gas**. That is what makes the volume
reachable without a budget.

### The constraint: a KeeperHub organization has only one wallet

`GET /api/user/wallet` says it explicitly — the wallet is *organization-scoped, not
per-user*. Yet invariant **I10** requires the `opener` and the `settler` to be two
distinct addresses: compromising the component that opens must not grant the power
to seize.

**KeeperHub can therefore hold only one of the two roles.** The other needs its own
key, with gas.

The choice made — KeeperHub as `opener`, a dedicated key for the `settler` — is the
right one in both directions:

- opening is the **volume** operation (one per warrant), and that is where
  sponsorship pays off;
- settlement is the **sensitive** operation: it is the only privilege that moves
  funds to a third party. Keeping it on a key we control, outside the execution
  infrastructure, shrinks the surface rather than widening it.

### Verified rather than asserted

The argument "the component that opens cannot seize" did not remain an assertion.
KeeperHub, once it had become `opener`, actually attempted a `slash`:

```
wouldRevert: true, data: 0x05b94333
0x05b94333 = NotSettler()
```

So the separation of roles was tested against a real caller, not against a mock —
and the contract refused.

### One more friction along the way

The ABI cannot be auto-fetched for an unverified contract, which is expected. But
the `abi` field must be passed as a **JSON string**, exactly like `functionArgs` —
a JSON array is rejected with the same message as if the field were absent:
*"ABI is required. Could not auto-fetch ABI…"*. The message never mentions that the
field was in fact received, but in the wrong format. Reported in the onboarding
teardown.

---

## 4. The Gateway opens a warrant on its own

The warrants in § 2 and § 3 were opened by hand, to exercise the contract. This one
was opened by the **Gateway's opening port** (`keeperHubEscrow`), that is, by the
code that will run in production, on the real chain.

| Step | Transaction |
|---|---|
| Funding the bond (5 USDC to the contract) | [`0x85498ebe…b4f9`](https://sepolia.etherscan.io/tx/0x85498ebe47af72053374797e3b48cf687d0b10bfabc7dad99520a69b0637b4f9) |
| **`open` by `keeperHubEscrow`** | [`0x269d4f4f…7fca`](https://sepolia.etherscan.io/tx/0x269d4f4f9d1803b301c523b573edb0c1188aebf46d04ff04268526c4b817fca7) |

`warrantId` `0x16e86a94…1160`. Re-read on an independent RPC, `warrants(id)`
returns `status = 1` (`Open`), `bond = 5,000,000`, and `totalLocked` advances by
the same amount. The funding goes **to the contract itself** and not to an
intermediate vault: `open()` requires `token.balanceOf(this) >= totalLocked`
(WarrantEscrow.sol:131), which is also the reason `WARRANT_PAY_TO` is the escrow's
address.

**What this transaction taught the project.** The response from
`POST /api/execute/contract-call` does **not** contain the transaction hash: a
`202` with `{ executionId, status: "completed" }`, and nothing else. The hash exists
only on the status route. A warrant opened without a hash is a warrant the Settler
cannot judge — it has no entry point from which to read the chain — even though the
bond has been taken and the warrant exists onchain. The first attempt did in fact
open a perfectly real warrant
([`0x1c46340c…6a3f`](https://sepolia.etherscan.io/tx/0x1c46340cb91696d59bff8266d0d58cd8a1ec0c8f680ddc3330003185b72f6a3f),
`sponsored: true`, 236,304 gas) that the client believed lost. The fix is in
`KeeperHubClient.executeContractCall`, and it is described in the onboarding
teardown.

---

## Replaying a verdict yourself

Every verdict publishes `evaluatedAtBlock`, `rpcUrl` and the `checks[]` detail,
with expected value and observed value. Evaluation is an onchain read at a pinned
block: anyone can redo it and get the same result, or observe a divergence.

That is the answer to "why should we trust you?" — we do not ask for trust, we make
the verdict reproducible.
