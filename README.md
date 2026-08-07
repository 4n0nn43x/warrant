# Warrant

**An agent doesn't get permission to act. It buys a mandate, and it loses the mandate if it lied.**

Warrant is a bonded-execution layer for onchain AI agents, built on KeeperHub. Before an agent
executes a risky action, it posts a stablecoin bond and cryptographically commits to the onchain
post-condition its action must produce. KeeperHub executes. An independent RPC read at a pinned
block decides: post-condition held → bond returned; post-condition violated → bond seized and the
verdict written to the ERC-8004 Reputation Registry.

---

## The inversion

The industry answer to agent risk is the guardrail that blocks: policy engines, spend caps,
allowlists. A blocking rule is only as good as the attack it was written to anticipate — Bankr had
rules, and an attacker who manipulates the *input* to the reasoning walks straight past the check on
its *output*.

The research answer is the receipt: it proves after the fact, guarantees nothing, offers no recourse.

Warrant asks a different question. Not *"do I allow this action?"* — which a manipulated model
answers badly — but *"is the agent willing to bet that the result will be what it announced?"*

A prompt injection can convince an agent to transfer funds. It cannot make the final onchain state
match a post-condition that was committed **before** the poisoned content was read.

## What is verifiable today

Everything below is on **Base Sepolia**, against Circle's **real USDC** — no mock token.

| | |
|---|---|
| Escrow contract | [`0x3ae9ad53…ff4e`](https://sepolia.basescan.org/address/0x3ae9ad53686383c80889F550065e810f72c2ff4e) · `feeBps` = 250 |
| Token | [`0x036CbD53…dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) — USDC, EIP-3009 native |
| A warrant opened **and funded in one transaction** | [`0xf95b25e4…3d87`](https://sepolia.basescan.org/tx/0xf95b25e41758a3debe25e42218124dd4c12d457541c4691691968ce66a653d87) — gas sponsored by KeeperHub |
| A honored warrant | [`0x3220b47e…c7b9`](https://sepolia.basescan.org/tx/0x3220b47e5f528010a1df1e1ee9b5fa3e5305989815ab3ae1f704b06b0062c7b9) — 195 000 refunded, 5 000 fee, at the rate frozen at open |
| A **slashed** warrant | [`0xe105c5e2…04c3`](https://sepolia.basescan.org/tx/0xe105c5e237eadebb38afce62c6a2b20e2b7e22697596a7d960c09a792fd504c3) — full bond to the beneficiary, **0 to the protocol** |
| ERC-8004 verdict, written onchain | [`0xc37ad72b…b650`](https://sepolia.basescan.org/tx/0xc37ad72b5fe60b59ec8561c49942a4bfe4bb31e87496ca1d5691b066ca6eb650) — `agentId 8652`, `−100 "slashed"` |
| ERC-8004 verdict, batched | [`0x2e8b5ead…f569`](https://sepolia.basescan.org/tx/0x2e8b5eadd5898bd9d1834592992bc405da465888654c402552fee6f99c6af569) — `+100 "honored"` |

Two properties you can check yourself, from chain state alone:

- **`fundingRef == termsHash(id, beneficiary, bond, conditionHash, actionHash, duration)`.** The
  EIP-3009 nonce *is* the hash of the committed terms, so signing the payment is signing the mandate.
  Recompute it with the contract's own `termsHash` view and compare.
- **`opener != settler` is enforced by the contract.** `setSettler(opener)` reverts `0x39a17874` =
  `RolesMustDiffer()`.

An earlier deployment on Ethereum Sepolia
([`0xadDC715B…de12`](https://sepolia.etherscan.io/address/0xadDC715B79Cb972d3a7f0dce5998CC141CaAde12))
is **pre-audit and vulnerable**. It is kept only as a historical record — do not use it. What the audit
found, and the proofs that each fix closes it, are in [`audit/`](audit).

Full detail, including what each transaction taught the project, in
[`docs/transactions.md`](docs/transactions.md).

**The slash is the one that matters.** A guardrail that blocks an attack produces no transaction, so
no evidence. Warrant turns the failure into a verifiable onchain artifact — and the reason is written
in plain text on the chain, readable by anyone:

```
erc20_balance_delta: attendu >=-1000000000, observe -9000000000 |
erc20_balance(allowed_dest): attendu >=1000000000, observe 0
```

## Two payment rails, one warrant

`POST /v1/warrants` answers its 402 with an x402 v2 `PAYMENT-REQUIRED` **and** an MPP
`WWW-Authenticate: Payment` on the same response, and takes either one back. KeeperHub shipped MPP
support in late July 2026 and an external agent paid it $0.01 over MPP within a day, so this is the
rail its own execution layer now speaks.

The method advertised is **`evm`** — "stablecoin payments on EVM chains with inline x402 exact
compatibility" in the [MPP method registry](https://mpp.dev/payment-methods) — and not `tempo`, which
is TIP-20 on the Tempo chain and a request schema this Gateway does not implement. The default used to
be `tempo`; a conforming client that selected us on that basis would have built a payload we refuse.

What makes the two rails produce *the same* warrant rather than a similar one is that both carry the
identical EIP-3009 authorization. The MPP Credential's `transaction` payload is unwrapped into the
x402 `PaymentPayload` and handed to the same facilitator, so `fundingRef` — the authorization's nonce,
which is the terms hash — is the same on either path. A test asserts the two openings field by field.

Client-side, the rail lives in [`warrant-sdk/mpp`](packages/sdk-ts/src/mpp.ts): it holds no key and
signs nothing, asking the caller's existing `PaymentSigner` for the same authorization the x402 rail
uses. A conformance test in `packages/server` holds the SDK's encoder against the Gateway's decoder,
and an end-to-end test drives the real Gateway through the published SDK rather than through a
test-local helper — the two shapes that could drift without either side's own tests noticing.

**Demonstrated onchain on 2026-08-07**, and it took the hosted Gateway plus a running Settler to do
it. Warrant [`0x15f34971…dde4`](verdicts/0x15f3497102114c00d663fd64e673005d2a5cf24f972cc149eea27057d127dde4)
was opened on the **MPP rail** against `warrant.fyra.fun`: 402 carrying both challenges on one
response, an EIP-3009 authorization whose nonce is the terms hash, the facilitator settling, KeeperHub
executing with sponsored gas, and the Settler slashing at a pinned block. `keccak256` of the document
GitHub serves equals the `feedbackHash` written to ERC-8004, and `replay-verdict.sh` reproduces all
four checks.

It was slashed, and correctly: the action transferred 1 USDC to `0x…dEaD` while the policy's allowlist
names another address. The post-condition is written by the policy, never by the agent, so a transfer
outside the allowlist fails by construction — which is the whole enforcement mechanism, observed
working rather than asserted.

The 60 warrants that predate it were opened by the operations tool, which bypasses the Gateway
entirely. They are labelled `rail: direct` for that reason; they used to claim `x402`, which inflated
a count of something that never happened.

## Using it from an agent

A Gateway is hosted at **`https://warrant.fyra.fun`** — Base Sepolia, real Circle USDC. Both SDKs
default to it, so there is no server to run, no account to create and no API key to obtain.

```bash
npm i warrant-sdk          # https://www.npmjs.com/package/warrant-sdk
pip install warrant-sdk    # https://pypi.org/project/warrant-sdk/
```

```python
from warrant_sdk.langchain import warrant_tools
tools = warrant_tools()    # the four tools, ready for your agent
```

The three read tools — `quote_risk`, `get_warrant`, `list_warrants` — need no key and spend nothing.
Only `request_warrant` costs money, and it answers a 402 with the terms before it does. Set
`WARRANT_BASE_URL` to run against your own Gateway instead.

## Repository layout

```
contracts/          WarrantEscrow.sol — 99 tests, 13 stateful fuzzing invariants, 9 audit PoCs
packages/core/      post-condition DSL, JCS canonicalisation, action classifier, risk pricing
packages/server/    402 Gateway, post-condition evaluator, settlement daemon, ERC-8004 writes
packages/mcp/       MCP server — 4 tools, protocol revision 2026-07-28
packages/sdk-ts/    the single source of tool definitions, plus framework adapters
packages/reputation-reader/   stake-weighted ERC-8004 score, read from onchain events
packages/sdk-py/    Python projection of the same tools — LangChain, CrewAI
apps/runner/        volume runner: opens and settles warrants on a budget
skills/             OpenClaw skill
verdicts/           published verdict documents — the bytes ERC-8004 commits to
audit/              recon, OWASP coverage gate, findings with runnable PoCs
```

## The escrow, in one paragraph

One contract. No proxy, no governance, no emergency withdrawal. Funds leave only through `honor`,
`slash` or `reclaim`. `reclaim` is deliberately permissionless after expiry, so a failing settler can
never hold an agent's bond hostage. A slash pays the beneficiary in full and the protocol treasury
**zero** — which is what removes the perverse incentive, and it is checked onchain, not just in a
test.

Two invariants are worth stating because they shape the deployment:

- **I9** — `honor` and `slash` revert after expiry. The settlement window closes; `reclaim` takes over.
- **I10** — `opener` and `settler` must be distinct addresses. Compromising the component that opens
  must not grant the power to seize.

I10 has a practical consequence: a KeeperHub organisation has exactly one wallet, so KeeperHub can
hold only one of the two roles. It holds `opener` — the volume operation, where gas sponsorship pays
off — while `settler`, the only privilege that moves funds to a third party, stays on a key we
control, outside the execution infrastructure. That separation was tested against a real caller, not
a mock: KeeperHub, once `opener`, attempted a `slash` and the contract answered `NotSettler()`.

## Running it

Requires Node ≥ 22, pnpm, and Foundry.

```bash
pnpm install
pnpm -r test          # TypeScript packages
pnpm test:contracts   # forge test, including the fuzzing invariants
```

Copy `.env.example` to `.env` and fill it in. Three settings deserve a warning, because each one
fails in a way that looks like something else:

- **`EVALUATOR_RPC` must be an archive node.** Evaluation reads state at a pinned past block, which
  is an archive request in the JSON-RPC sense. Several popular public endpoints answer `latest`
  happily and refuse everything historical — so the failure appears only once you wire up
  settlement, and every published verdict becomes unreplayable.
- **`OPENER_PRIVATE_KEY` and `SETTLER_PRIVATE_KEY` must be different keys** (invariant I10). The
  contract now enforces this in the constructor and in both setters — an audit found that it did not,
  and that the fuzzing invariant which claimed to verify it drew the two roles from disjoint pools, so
  it could never fail. Both are fixed; the Gateway also refuses to start when the two coincide.
- **The x402 facilitator must support your chain.** The public facilitator at `x402.org` serves Base
  Sepolia and nothing else on EVM — not Base mainnet, not Ethereum Sepolia. A mainnet target needs a
  Coinbase Developer Platform facilitator and its credentials.

## Replaying a verdict yourself

Every verdict publishes `evaluatedAtBlock`, `rpcUrl` and the full `checks[]` with expected and
observed values. Evaluation is an onchain read at a pinned block: anyone can redo it and get the same
answer, or find a discrepancy.

No `.env`, no account, nothing of ours but a public RPC — you need `cast`, `jq` and `python3`.
[`verdicts/`](verdicts) holds **57 settled warrants** on Base Sepolia — 47 honored, 7 slashed, 3
settled by an agent with no ERC-8004 identity. All 57 were replayed against the registry on
2026-08-06: **57 `VERDICT REPRODUCED`, no divergence.** Two to start with:

```bash
R=0x8004b663056A597dfFE9eCcC1965a193B7388713   # ReputationRegistry, Base Sepolia

# a seizure — committed on its own, one document for one warrant
./scripts/replay-verdict.sh 0x43223a3b5c4159f68302f25f3c925216aa5b298fdb32bf82c7bd84be06b38df5 --registry $R

# an honoured warrant — committed inside a batch, under a single feedbackHash
./scripts/replay-verdict.sh 0x953ad5be12adc437bb5c0142549bee85c70557e40807be39f7b94b107592f791 --registry $R
```

Each run prints `VERDICT REPRODUCED`, `VERDICT PARTIALLY REPRODUCED` or `DIVERGENCE`, exit code included, after six checks: the escrow
`status`, the document's availability, `keccak256` of the served bytes against the committed
`feedbackHash`, `conditionHash` / `actionHash` / `fundingRef` recomputed from the document, the action
transaction, and a full replay of `checks[]` at the pinned block. `--registry` adds the last link —
finding that `feedbackHash` in a real `NewFeedback` event — and is the one step the script cannot do
from the escrow alone.

By hand, the two lines that matter most:

```bash
cat verdicts/0x43223a3b5c4159f68302f25f3c925216aa5b298fdb32bf82c7bd84be06b38df5 | cast keccak
# → 0xc113e15c0192f1f8d225b0220951dd7d13c9416dca74fb7f92c6dfee8cf4dde9, the feedbackHash onchain
cast call 0x3ae9ad53686383c80889F550065e810f72c2ff4e 'warrants(bytes32)(address,address,uint256,bytes32,bytes32,bytes32,uint64,uint64,uint16,uint8)' 0x43223a3b5c4159f68302f25f3c925216aa5b298fdb32bf82c7bd84be06b38df5 --rpc-url https://sepolia.base.org
# → status 3 (Slashed), and the conditionHash / actionHash the document must hash back to
```

Verdict documents are **files in this repository**, under [`verdicts/`](verdicts) — served
byte-for-byte by `raw.githubusercontent.com`, timestamped by git history, and replicated by anyone who
clones. No host of ours sits between the commitment and the reader.
[`verdicts/index.json`](verdicts/index.json) maps each `feedbackHash` to the URI that serves those
exact bytes, batch documents included.

**Not every document is a commitment, and the index says which.** Slashes are written to ERC-8004
immediately, one feedback per verdict; honored warrants are **batched**, one feedback for N verdicts.
A batched warrant therefore has two documents: its own, published so that every warrant has a page,
and the batch — the only form whose hash was ever inscribed. 47 of the 57 carry a
`batchFeedbackHash` naming their carrier; without it, checking a document's own hash against
`NewFeedback` would come up empty and look like a broken commitment. `--registry` follows that link
for you and reports which form carried the proof.

Three caveats, stated rather than discovered:

1. A verdict is written at settlement and committed to git afterwards, so between the two the public
   URI 404s. The hash is already true — only availability lags, and the script says so when it falls
   back to the local copy of the repository. `pnpm verdicts:publish` closes the gap: it collects what
   the Settler wrote, refuses anything that is no longer in canonical form, and rebuilds the index.
2. The `feedbackURI` recorded onchain for the earliest verdicts reads `https://warrant.sh/v/…`. That
   was a mistake: the domain belongs to an unrelated project, and this one never owned it. It was the
   default before `VERDICT_BASE_URI` was pointed at this repository, and the default has since been
   changed at the source so it cannot recur. Those URIs are onchain and immutable — but what binds a
   document to its commitment is the **hash**, not the path. `verdicts/index.json` maps one to the
   other, and `replay-verdict.sh` resolves it for you.
3. A document only carries an ERC-8004 commitment when the settling agent has an identity in the
   registry. Three warrants — [`verdicts/0x45482f78…`](verdicts) among them — were settled without
   one, so they are raw `VerdictDocument`s whose hash appears in no `NewFeedback`. They still replay
   in full against the escrow — five of the six checks do not involve ERC-8004 at all — and
   `--registry` says so explicitly instead of reporting a divergence it would have manufactured.

`verdicts/` serves **one deployment**: Base Sepolia, post-audit. Settlements against the earlier
Ethereum Sepolia contracts are kept out of it — mixing them in would put verdicts produced by the
contract this README tells you not to use in the same list as the ones offered for verification.
Their history is in [`docs/transactions.md`](docs/transactions.md).

That is the answer to *"why should we trust you?"* — we don't ask for trust, we make the verdict
reproducible.

## The limit, stated before you find it

> **Warrant guarantees outcome conformance, not decision quality.**

Post-conditions are strictly onchain-verifiable: balance deltas, allowance, health factor, nonce,
emitted event. Warrant does not judge the intent or the wisdom of a decision — that is undecidable,
and claiming otherwise collapses at the first counterexample. This boundary is a documented design
choice, not a gap.

## License

MIT.
