# Onboarding teardown — timestamped log

A log of the frictions hit while starting from zero on KeeperHub, kept **as they
happened**. Reconstituting these notes on 12 August would be impossible: we would
have forgotten them, and it would show.

The format of an entry: timestamp, what we were trying to do, what happened, what
would have avoided the blocker. A friction with no proposed fix is just a
complaint.

Target: the **Best Onboarding UX Improvement** bounty ($1,000, two winners,
stackable with the Grand Prize). KeeperHub's previous hackathon produced 197
distinct findings distilled into 47 tickets — that is a format they know how to
act on.

---

## 2026-07-28

### 11:09 — Starting point

Empty repository. No KeeperHub account, no API key. All the design documentation
is written (`../docs/`), nothing is implemented.

### 11:12 — Foundry missing from the machine

Not a KeeperHub friction, noted for reproducibility: `forge` was not installed.
`curl -sL https://foundry.paradigm.xyz | bash && foundryup` was enough, version
1.7.1. Clean install, attestation verified.

### 11:20 — The live OpenAPI is not the REST API's spec

**What we were looking for**: a machine-readable schema to generate the REST
client.

**What we found**: `app.keeperhub.com/api/openapi` serves a 79-path OpenAPI 3.1
document in which **every** path is a `POST /api/mcp/workflows/{slug}/call`. That
is the marketplace catalogue, not the REST CRUD. The execution and audit-trail
endpoints — the ones any hackathon project depends on — are not in it.

**Concrete consequence**: the `packages/server/src/keeperhub.ts` client has to
parse the execution record defensively, accepting several naming conventions
(`txHash` / `transactionHash` / `tx_hash`), because there is no way to know which
one is right before actually calling the API.

**Proposed fix**: either publish a second OpenAPI document for the REST API, or
rename this one to `/api/marketplace/openapi` and document it as such. One line in
`docs.keeperhub.com/api` saying "the live OpenAPI covers the marketplace, not the
CRUD" would have been enough to avoid the confusion.

### 11:22 — Stale `llms.txt` on the wallet provider

`docs.keeperhub.com/llms.txt` announces **Para MPC wallets**. The product
documentation (`docs.keeperhub.com/wallet-management`) says **Turnkey**, and lists
Para as a **discontinued** integration.

`llms.txt` is precisely the file an agent reads first. It is therefore the most
expensive one to let drift: a builder who trusts it writes their submission with
the wrong provider name.

**Proposed fix**: regenerate `llms.txt` from the docs on every build, or at
minimum date the last synchronisation in it.

### 11:23 — "Non-custodial" vs "custody is server-side"

Marketing says non-custodial; `docs.keeperhub.com/ai-tools/agentic-wallet`
describes a Turnkey sub-organization per wallet with *"custody is server-side"*.
Both claims are defensible separately but contradict each other for a reader in a
hurry, and that is exactly the kind of nuance a builder copies wrong into their
submission.

**Proposed fix**: a single canonical sentence, reused everywhere — for instance
"keys in an enclave, never on disk, custody delegated to Turnkey".

### 11:24 — "Open source" without an OSI licence

The `KeeperHub/keeperhub` repository is announced as open source on the site, on
the hackathon page and in the bounty brief ("KeeperHub is open source, and the
fastest way to make it better is fresh eyes"). Yet GitHub classifies the licence
as **`NOASSERTION`**.

**Why it concretely blocks**: the bounty asks for a merged PR. Contributing code
to a repository with no clear licence raises a rights-assignment question that a
careful contributor will ask before opening the PR — that is, at the worst
possible moment.

**Proposed fix**: add an explicit `LICENSE` at the root, and mention it in the
bounty brief.

### 13:40 — Two families of keys, only one prefix prominently documented

**What we did**: pasted the key retrieved from the account settings into `.env`.
It starts with `wfb_`.

**What happened**: 401 everywhere. On `/mcp` (`invalid_token`), on `/api/user`, on
every authenticated route.

**The cause**: KeeperHub has **two** families of keys, managed by **two**
different endpoints, and the "API Keys" page presents both tabs side by side
without warning:

| Prefix | Scope | Created in | Usable for |
|---|---|---|---|
| `kh_` | Organization | Settings → API Keys → **Organisation** tab | REST, MCP, Claude Code plugin |
| `wfb_` | User | Settings → API Keys | **a single route**: `POST /api/workflows/{id}/webhook` |

A `wfb_` key is therefore rejected by 99% of the platform, and the error message
(`invalid_token`) does not say why.

**Proposed fixes**, in order of return:
1. Make the 401 say *which* family of key was presented:
   "this endpoint requires an organization key (`kh_`); you presented a user
   webhook key (`wfb_`)". The prefix is known to the server, the information is
   free.
2. Rename the "User" tab to "Webhook keys (`wfb_`)" in the UI.
3. Put the prefix table at the top of `docs.keeperhub.com/api`, not only in
   `/api/authentication`.

### 13:45 — No REST route is discoverable from the API

**What we did**: hunted for the endpoint that reads an execution by probing
plausible names.

**What happened**: `/api/executions`, `/api/runs`, `/api/keeper-runs`,
`/api/execute`, `/api/wallets` → all `404 not_found`. None of them hints at the
right shape.

**The real routes**, found only by reading the HTML docs page by page:

| What we were looking for | Actual route |
|---|---|
| execute a contract call | `POST /api/execute/contract-call` |
| status of a direct execution | `GET /api/execute/{id}/status` |
| status of a workflow execution | `GET /api/workflows/executions/{id}/status` |
| wait for the terminal state | `GET /api/workflows/executions/{id}/wait` |
| the organization's wallet | `GET /api/user/wallet` |

Workflow executions live under `/api/workflows/executions/…` and not under
`/api/executions`: that is the exact cause of our 404s.

**Proposed fix**: a `GET /api` route returning the route index, or a `404` that
suggests the closest route ("did you mean
`/api/workflows/executions/{id}/status`?"). Cost: a few lines. Gain: the half hour
every new builder loses here.

### 13:50 — The entire marketplace answers 503

Every workflow tested — `helloworld`, `aave-v3-health-check`,
`usdc-yield-rates-aave-vs-compound`, `defi-risk-snapshot` — returns
`503 "The workflow owner has disabled this workflow"`, **both** with and without
authentication.

Yet the `GET /api/mcp/workflows` catalogue answers 200 and now lists only **20**
workflows, against **79** in the live OpenAPI consulted two hours earlier the same
day.

A builder who starts with the marketplace quickstart concludes that their own
configuration is at fault and loses their afternoon. **Proposed fix**: a status
page, or at minimum a message distinguishing "this workflow is disabled by its
author" from "the service is unavailable".

### 13:55 — The MCP `initialize` does not test authentication

`POST /mcp` `initialize` **always** returns `200` with
`authentication.required: true`, even with no token, even with an invalid token.
That is a capability announcement, not a verdict.

So we believed the key had been accepted when it had not. The real check only
appears on `tools/list`.

**Proposed fix**: document it in one sentence in `ai-tools/mcp-server` — "to
verify your credentials, call `tools/list`, not `initialize`".

### 14:12 — First real transaction, and two surprises

`POST /api/execute/contract-call` on Base Sepolia, `approve(0xdEaD, 0)` on testnet
USDC. **It went through**:
`0xaf65a4e68a3a567729c95c3b2fef324612d70544aae930f2f7ae09a43cb4d315`,
block 44736245, `sponsored: true` — even though the organization's wallet is
**empty on all 20 chains**. Gas sponsorship works, at least on testnet.

**Surprise #1 — the API does not accept raw calldata.**

The body expects `functionName` and `functionArgs`, and fetches the contract's ABI
automatically. There is no field at all for passing pre-encoded calldata: `data`,
`callData` and `calldata` are all ignored, and the error returned talks about
`functionName` without ever saying that raw calldata is not an option.

Worse, `functionArgs` must be **a JSON string**, not an array:

```jsonc
// rejected with a 400, no hint about the real shape
{ "functionName": "approve", "args": ["0x…", "0"] }
// rejected: "functionArgs must be a JSON string when provided"
{ "functionName": "approve", "functionArgs": ["0x…", "0"] }
// accepted
{ "functionName": "approve", "functionArgs": "[\"0x…\",\"0\"]" }
```

It took probing six field names to find `functionArgs`, and then working out the
string encoding. **Proposed fix**: accept a JSON array directly (or at minimum
mention it in the error message), and document that pre-encoded calldata is not
supported — that is an assumption anyone who has used `eth_sendTransaction` will
make.

**Surprise #2 — a sponsored transaction has neither the expected `from` nor the
expected `to`.**

This is the structuring discovery of the day. The execution record lets you see it
in `result.executedCall.topLevelTo`, but nothing explains it:

| | Expected | Actual |
|---|---|---|
| `tx.from` | org wallet `0x1f8547…` | **relayer `0x6331eb45…`** |
| `tx.to` | target contract `0x036cbd…` | **forwarder `0x5aF5194B…`** |
| `tx.input` | `approve(0xdEaD,0)` | `execute(address,address,uint256,bytes)` |

The real calldata is wrapped: `execute(wallet, target, value, data)` where `data`
contains a 65-byte signature, some metadata, then the target calldata.

**What this breaks, for any project that verifies its executions:**

- every check of the form `tx.to == target_contract` fails;
- every `tx.input == expected_calldata` check fails;
- **the organization wallet's nonce does not advance** — it is the relayer that
  emits the transaction.

Checks by **effect** (`Transfer`/`Approval` logs, balance deltas, state reads at a
block) remain valid: the `Approval` log really is emitted by the USDC. That is the
only reliable basis.

**Proposed fix**: document the shape of a sponsored transaction in
`wallet-management/gas`, with the forwarder address per chain and the ABI of
`execute`. A team that builds an execution proof on `tx.to` will only find out in
production — or, for a hackathon, during the demo.

### 15:20 — `abi` must be a JSON string, and the error message hides it

To execute a call on an **unverified** contract, you must supply the ABI. The field
exists and is called `abi`. But like `functionArgs`, it expects a **JSON string**,
not an array.

The trap is in the message: passing a JSON array produces exactly the same error
as passing nothing at all.

```
{"error":"ABI is required. Could not auto-fetch ABI: Unable to fetch ABI for
 0xadDC… on chain 11155111. Contract may not be verified.","field":"abi"}
```

So you conclude the field is not supported, and you look elsewhere — I probed
`contractAbi` and `abiJson` before remembering the `functionArgs` convention.

**Proposed fix**: distinguish the two cases. "ABI is required" when the field is
absent; "`abi` must be a JSON string when provided" when it is present but
mistyped — that is the message the API already produces for `functionArgs`, it just
needs applying here too.

### 15:25 — An organization has only one wallet, and that constrains the architecture

`GET /api/user/wallet`: *"The wallet is organization-scoped, not per-user."*

This is not a defect, but it is an architectural constraint that deserves
announcing at the top of the wallet documentation rather than being discovered in
use. Any project with **two distinct onchain roles** — which is the case as soon as
you separate a write privilege from a settlement privilege — can entrust only one
of them to KeeperHub. The other needs its own key and its own gas, hence a budget,
hence a design decision.

We discovered this by moving the `opener` over to the KeeperHub wallet and finding
that the `settler` would have to move there too, which would have destroyed the
invariant guaranteeing that a compromised component cannot seize funds.

**Proposed fix**: a sentence in `wallet-management` — "an organization has a single
execution wallet; if your contract distinguishes several onchain roles, only one of
them can be held by KeeperHub" — and, eventually, the ability to provision several
wallets per organization.

---

## Contradictions found in the documentation

### Gas sponsorship on Ethereum mainnet

The hackathon page announces: *"KeeperHub offers gas sponsorship on mainnet
Ethereum."*

`docs.keeperhub.com/wallet-management/gas` states four cumulative conditions, the
third of which is: *"transactions routed through a private mempool are not
sponsored"*.

Yet `GET /api/chains` returns `usePrivateMempoolRpc: true` for **Ethereum
Mainnet (1)** and Sepolia — and for no other chain.

Taken literally, Ethereum mainnet is therefore **excluded** from the sponsorship
the hackathon puts forward. Either an override exists for the event, or the
announcement is ahead of the configuration. **To be settled on Discord before
building a demo on the assumption of free gas on L1.**

### Simulation absent from the audit trail

`docs/08-integration-keeperhub.md` § 4 of this project assumed the simulation
result was readable in the audit trail. It is not: `simulate: true` inserts **no**
execution row, and the result exists only in the synchronous HTTP response.

Consequence for Warrant: the simulation must be called explicitly **before** the
warrant is opened, and its result kept by us. That is feasible and in fact
cleaner, but the design document has to be corrected.

### `blockNumber` is exposed nowhere

No route returns the inclusion block number. It has to be derived from the
`txHash` via an RPC.

No consequence for Warrant — the Settler waits for confirmations on an independent
RPC anyway, and it is that receipt that is authoritative — but it is a surprise for
anyone building an indexer on the audit trail alone.

---

## To verify at first contact with the API

These points cannot be settled without an API key. They are open.

| # | Question | Why it blocks |
|---|---|---|
| 1 | **The organization's daily spend cap**: what is the default value, and where is it set? `GET /api/analytics/spend-cap` reads it, no route writes it | Going over it makes executions fail with a 403 until midnight UTC |
| 2 | **Mainnet gas sponsorship**: does the hackathon override exist despite `usePrivateMempoolRpc: true`? | The contradiction noted above. Sizes the entire demo |
| 6 | Is there a limit on the size of an accepted x402 payment? | Sizes `maxBond` |

**Resolved on 2026-07-28**: the shape of the execution record, the REST routes,
the key format, headless MCP authentication (a `kh_` key as a Bearer token is
enough, no OAuth), and the agentic wallet's caps — 200 USDC/day, 100 USDC per
transfer, Base + Tempo allowlist, **not configurable** ("not user-configurable
today"; raising them requires an operator action). Those caps concern only the
**agentic wallet** that pays for x402 workflows, not the organization's execution
wallet, which does cover all 22 chains including Ethereum mainnet.

---

## 2026-07-29

### Context

Implementation day: real wiring of the Gateway and the Settler, MCP migration, and
systematic verification of what the documentation claimed. The entries below are
the frictions hit that day. Three of them are **ecosystem** frictions more than
KeeperHub ones, but they strike any hackathon team in the same order, and deserve
reporting on that basis.

### KeeperHub's MCP server has stayed in the `initialize` era

On 28 July 2026 — the very day the hackathon closed for registrations — MCP
revision **`2026-07-28`** was published as final. It removes the `initialize`
handshake and the `Mcp-Session-Id` header: the protocol becomes *stateless*. Six
SEPs contribute to it, and the maintainers describe it as the most substantial
change since authorization was added.

**Direct consequence for an earlier entry in this log.** The 28/07 13:55 entry
reported that `POST /mcp` `initialize` always answers `200`, even without a token,
and that the real authentication check only appears at `tools/list`. The proposed
fix was to document it. **That fix is obsolete**: `initialize` no longer exists in
the current revision. The useful advice becomes this — plan the MCP server's
migration to `2026-07-28`, where the question no longer arises, since every request
carries its own authentication context and validation is done header by header
(`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, with a `-32020 HeaderMismatch`
rejection when they diverge from the body).

The TypeScript SDK followed the same day: the monolithic
`@modelcontextprotocol/sdk` package is retired in favour of
`@modelcontextprotocol/server` and `@modelcontextprotocol/client` at `2.0.0`.

**Proposed fix**: announce on `docs.keeperhub.com/ai-tools/mcp-server` which
protocol revision is actually served, and the target date for moving to
`2026-07-28`. A builder migrating their own server needs to know whether the server
on the other side will follow, because the two eras only interoperate through an
explicit fallback.

### The public x402 facilitator covers no production-usable network

`GET https://x402.org/facilitator/supported` returns, for EVM networks:

```
eip155:84532  (Base Sepolia)   ← the only one
base-sepolia                    ← the same, under its legacy name
```

Neither `eip155:8453` (Base mainnet) nor `eip155:11155111` (Ethereum Sepolia). The
rest of the list is non-EVM: Solana, Aptos, Algorand, Hedera, Stellar, XRPL.

**Why this pinches here.** The hackathon values mainnet, and KeeperHub executes on
22 chains. But a project that collects in x402 can only do so, with the public
facilitator, on **Base Sepolia**. Going to production requires the CDP facilitator
(`api.cdp.coinbase.com/platform/v2/x402`), hence a Coinbase Developer Platform
account and keys — a signup step mentioned in none of the quickstarts crossed so
far.

**Proposed fix**: say explicitly, on the x402 page of the KeeperHub
documentation, that the public facilitator is a **Base testnet only** facilitator,
and that any mainnet target presupposes a CDP account. Two sentences save you from
discovering the constraint after deploying your escrow on the wrong chain.

### A widespread public RPC cannot serve pinned-block reads

An ecosystem friction, but it deserves to be here because it is invisible and its
failure mode is deceptive.

`ethereum-sepolia-rpc.publicnode.com` — one of the first RPCs you paste into a
`.env` — answers `eth_blockNumber` and any `latest`-block call correctly, but
refuses **every** archive request:

```
eth_call    at a past block      -> -32602 "Archive requests require a personal token"
eth_getLogs over a past range    -> HTTP 403, same message
```

Yet any hackathon project that verifies *after the fact* what an execution produced
is, by definition, doing a pinned-block read. So the RPC works throughout
development and starts failing at exactly the moment you wire up evaluation. For
Warrant it was worse than an outage: every verdict publishes the `rpcUrl` it used,
promising that anyone can replay the evaluation, and on that RPC the promise was
unverifiable.

`sepolia.drpc.org` does the job with no key (`eth_getLogs` cap: 10,000 blocks per
request).

**Proposed fix**: one line in the KeeperHub quickstart — "the RPC you use to
verify an execution must be an archive node; not all public RPCs are" — with two
working examples.

---

### 17:05 — The execution response does not contain the transaction hash

This is the most expensive friction of the day, because it has the appearance of a
success.

`POST /api/execute/contract-call` **blocks** until the execution finishes — 23 s
measured on Sepolia — then answers:

```jsonc
// HTTP 202
{ "executionId": "9z08b35kdd8fwiz14gtr0", "status": "completed" }
```

A finished execution, a `completed` status, and nothing with which to go verify it.
The `transactionHash`, the `sponsored` flag, the gas consumed and the
`executedCall` exist only on `GET /api/execute/{id}/status` — where they are
available **immediately**, with no further wait.

Three things make this a trap rather than a mere omission:

1. **The status code lies about the semantics.** A `202 Accepted` announces
   asynchronous processing still to come; here the processing is *already
   finished*. You naturally conclude that the hash will arrive later, and you write
   a polling loop that serves no purpose — when an immediate `GET` is enough.
2. **Nothing signals the absence.** The field is not `null`, it is absent. A client
   reading `response.transactionHash` gets `undefined` and, if it does not check,
   records a successful execution with no proof.
3. **The consequence is silent and late.** For Warrant, a warrant opened without a
   hash is a warrant the Settler can no longer judge: it has no entry point from
   which to read the chain. The bond has been taken, the warrant exists onchain,
   and settlement becomes impossible. The bug is invisible at the moment it is
   committed.

**Proposed fix**: include `transactionHash` and `transactionLink` in the POST
response — it is already blocking, and the information is already known by the time
it is written. Failing that, answer `200` rather than `202`, and document in one
sentence that the hash is obtained from the status route.

### 17:20 — An organization has only one wallet: the configuration-side corollary

Already noted at 15:25, but its side effect deserves saying separately, because it
only manifests after the fact.

Transferring the `opener` role to the KeeperHub wallet changes **the onchain state
without changing anything in the local configuration**. The key that used to be
`opener` is still in the `.env`, still valid, still able to sign — it simply no
longer has the right. So the Gateway kept starting up normally, and the error would
only have surfaced on the first **paid** warrant: bond settled, then `open()`
reverting with `NotOpener()`.

The countermeasure adopted is a consistency check at startup: the Gateway reads
`opener()` on the chain and refuses to start if the address about to sign is not
that one. Zero cost, and the error becomes impossible to ignore.

**Proposed fix**: in `wallet-management`, mention that entrusting an onchain role to
the organization's wallet creates an implicit dependency between the contract's
state and the client's configuration, and suggest the startup check as a pattern.
