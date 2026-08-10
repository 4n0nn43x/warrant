---
name: warrant
description: Bonded execution for onchain actions. Prices the bond for a transaction, opens a warrant committing to a verifiable onchain post-condition, then reads the replayable verdict. Use before a risky onchain action — ERC-20 transfer or approve, Aave supply, withdraw, borrow, repay — when the agent should put money behind its claim instead of asking permission.
version: 0.1.0
metadata:
  openclaw:
    requires:
      anyBins:
        - uvx
        - pipx
    primaryEnv: WARRANT_PRIVATE_KEY
    envVars:
      - name: WARRANT_BASE_URL
        required: false
        description: Warrant Gateway root. Defaults to the hosted one, https://warrant.fyra.fun.
      - name: WARRANT_PRIVATE_KEY
        required: false
        description: Agent key that signs the EIP-3009 bond authorization. Only request_warrant needs it — the three read tools work without a key.
    emoji: "⚖️"
    homepage: https://github.com/4n0nn43x/warrant
---

# Warrant — bonded execution

An agent does not get permission to act. It **buys a mandate**, and it loses the
mandate if it lied.

Before a risky onchain action, the agent posts a stablecoin bond and commits to
the onchain post-condition its action must produce. KeeperHub executes. An
independent RPC read at a pinned block decides: post-condition held → bond
returned; post-condition violated → bond seized and paid to the beneficiary,
with the verdict written to the ERC-8004 Reputation Registry.

Use this skill when the user asks to *bond*, *insure*, *guarantee* or *commit to*
an onchain action, or when they want proof after the fact that an action did what
it said it would.

## Two rules that decide whether your call succeeds

**1. Category and notional are derived from the calldata, never declared.**
No tool accepts a `category` or a `notional` field. Do not invent one; if you
send one it is silently dropped before the request is hashed. The bond is
`clamp(minBond, riskBps × notionalUSD, maxBond)`, and `notionalUSD` is decoded
from the calldata you submit. This is not a formality — an agent that could
declare its own category could choose its own risk price.

**2. `request_warrant` costs money.** Called without payment it returns a
structured error carrying an x402 v2 `PaymentRequired` object. That is not a
failure, it is step 2 of the payment protocol. Read it, fund it, call again.

## Setup

One command, no build step:

```bash
uvx --from warrant-sdk warrant tools
```

That prints the four tool definitions and exits. If it works, the skill is ready.
`warrant-sdk` is on PyPI, so `uvx` fetches it directly — there is nothing to
clone and nothing to build.

With `pipx` instead of `uv`, every command below is the same with
`pipx run --spec warrant-sdk warrant …` in place of
`uvx --from warrant-sdk warrant …`. Either binary is enough; the frontmatter
declares both under `requires.anyBins`, so OpenClaw gates the skill off rather than
offering a tool that cannot run.

The tools talk to the hosted Gateway at `https://warrant.fyra.fun` unless told
otherwise — Base Sepolia, real Circle USDC, no account and no signup. Set
`WARRANT_BASE_URL` to point at your own Gateway instead. Set
`WARRANT_PRIVATE_KEY` only when you actually intend to open a warrant — the
three read tools need no key and spend nothing.

No Gateway to hand? Start one that verifies signatures and moves no money:

```bash
python packages/sdk-py/examples/mock_gateway.py --port 8402
```

## The sequence

Always in this order. Skipping step 1 means committing to a price you never saw.

```bash
# 1. Free. What will this action cost to bond, and what will be committed?
uvx --from warrant-sdk warrant call quote_risk '{
  "actionSpec": {
    "version": 1,
    "chainId": 84532,
    "target": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    "value": "0",
    "calldata": "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240",
    "registryRef": "0x0000000000000000000000000000000000000000000000000000000000000001"
  }
}'

# 2. Paid. Opens the warrant, funds the bond over x402, triggers execution.
#    With no WARRANT_PRIVATE_KEY it exits 2 and prints the 402 challenge instead
#    of paying — which is how you show a user the price before committing.
uvx --from warrant-sdk warrant call request_warrant '{
  "actionSpec": { … same object, byte for byte … },
  "beneficiary": "0x…"
}'

# 3. Free. The verdict, with one line per check — including the ones that passed.
#    Right after an open this shows status 1 (Open) and checks: [] — the verdict
#    exists once the Settler evaluates the post-condition at the pinned block.
#    That is not a failure and not something to retry in a loop.
uvx --from warrant-sdk warrant call get_warrant '{"warrantId": "0x…"}'

# 4. Free. The agent's record: how many warrants honored, slashed, reclaimed.
uvx --from warrant-sdk warrant call list_warrants '{"agent": "0x…"}'
```

The `actionSpec` in step 2 must be **identical** to the one in step 1. It is
hashed into `actionHash`, which is the commitment; a single changed byte is a
different action at a different price.

`registryRef` is not a placeholder you can invent. A real Gateway answers HTTP 422
with `type: …/problems/registry_mismatch` when it does not match the classification
registry being served, because a commitment made against another registry version
would not be replayable. The refusal carries the value to use:

```json
{"error": {"code": "gateway_error", "details": {
  "type": "urn:warrant:problem:registry_mismatch",
  "declared": "0x00…01", "expected": "0x62bc8078…"}}}
```

Copy `details.expected` into `actionSpec.registryRef` and call again. Do this once
per deployment, then reuse the value — and never change it between step 1 and
step 2, since it is part of `actionHash`.

`beneficiary` has no default and must not be guessed. It is the address that
receives the bond if the post-condition is violated — the capital owner, never the
agent itself, and the escrow rejects both the agent and the protocol treasury.
Ask the user, or read it from the deployment's policy. If it disagrees with the one
the Gateway commits, the call is refused rather than signed.

## Paying the bond — read this before you debug a signature

The bond is funded by an **EIP-3009 `ReceiveWithAuthorization`** authorization
that the agent signs. Two things about it break every integration that assumes
the defaults:

- The signed type is `ReceiveWithAuthorization`, **not**
  `TransferWithAuthorization`. Standard x402 `exact` implementations sign the
  latter. Both types carry the same six fields and produce different typehashes,
  so a wrong-type signature is indistinguishable from a right one until the token
  rejects it — the transaction reverts with `FiatTokenV2: invalid signature` on
  Circle's USDC, and nothing in it explains why.
  The 402 challenge announces the correct type in
  `accepts[0].extra.primaryType`; trust that field over any library default.
  It also announces `accepts[0].extra.assetTransferMethod: "eip3009-receive"` —
  **not** the `"eip3009"` the x402 `exact` scheme prescribes, because in the spec
  `eip3009` means `transferWithAuthorization`, which this escrow cannot consume.
  Both fields must read `receive`; a challenge that says `eip3009` is refused
  rather than signed.
- The authorization **nonce is not random**. It must equal
  `termsHash = keccak256(abi.encode(warrantId, beneficiary, bond, conditionHash, actionHash, duration))`,
  where `warrantId = keccak256(abi.encode(agent, nonce, actionHash))`. Signing
  the payment is therefore signing the terms — which is the whole point, since
  EIP-3009's six fields say nothing about *which warrant* is being funded. The
  Gateway publishes every term in the 402 under
  `extensions["warrant/commitment"].info`, and the `nonce` it hands you must be
  echoed back in the request body. Get this wrong and you get `TermsMismatch()`.

`warrant call request_warrant` does all of this for you when
`WARRANT_PRIVATE_KEY` is set. The details are here so that when it fails, you
know what to look at.

## When something fails

The result is always JSON on **stdout**, including errors. The exit code says which
kind of answer you got:

| exit | stdout | meaning |
| --- | --- | --- |
| `0` | the tool's result | done |
| `1` | `{"error": {…}}` | a failure, with `hint`, `docs` and usually `field` |
| `2` | `{"paymentRequired": {…}}` | the bond is not funded. **Not a failure** — step 2 of the x402 protocol |

On exit 1:

```json
{"error": {"code": "invalid_action_spec", "message": "…", "hint": "what to do next", "docs": "https://github.com/4n0nn43x/warrant/action-spec", "field": "$.actionSpec.calldata"}}
```

Read `field`, fix that one thing, call again. Never retry an unchanged call.

On exit 2, read `paymentRequired.accepts[0].amount` — the bond, in atomic units of
`accepts[0].asset`. Either tell the user what it costs and let them decide, or set
`WARRANT_PRIVATE_KEY` and run the same command again.

Codes worth knowing:

| code | what it means | what to do |
| --- | --- | --- |
| `classification_failed` | `(target, selector)` is not in the classification registry. | Call `quote_risk` anyway: an unknown action is still bondable, at the strictest rate. |
| `invalid_action_spec` | A field of the action is malformed. | Fix the field named in `field`. Never add `category` or `notional`. |
| `payment_invalid` | The bond could not be signed or was refused. `message` names the term that diverged. | Read the section above on `ReceiveWithAuthorization` and `termsHash`. |
| `warrant_not_found` | No warrant under that id. | Check the id; `list_warrants` enumerates the ones that exist. |
| `gateway_unreachable` | The Gateway is down. Nothing was committed, nothing was paid. | Retry, or check `WARRANT_BASE_URL`. |
| `gateway_error` | The Gateway refused for a reason of its own; `details` carries its RFC 9457 problem document, and `details.type` names it. | Read `details`. On `…/problems/registry_mismatch`, copy `details.expected` into `actionSpec.registryRef`. On `…/problems/missing_nonce`, the 402's `nonce` was not echoed back. |

## The four tools

<!-- BEGIN GENERATED: tools -->
<!-- Generated from the manifest. Edit codegen/skill-template.md, not this block. -->

### `quote_risk` — free

_Quote the bond for an action_

Estimates the bond required for an action, committing nothing and paying nothing. Classifies the calldata, derives the notional from it, then returns the bond, the risk rate and the post-condition that will be committed. Call this before request_warrant: it is free, and it is the only way to learn the cost before committing. The category and the notional are derived from the calldata; they cannot be declared.

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `actionSpec` | object | yes | The transaction to execute. Accepts neither category nor notional: both are derived from the calldata, never declared. |
| `beneficiary` | string | no | Beneficiary of a potential slash. Does not affect the price; used to build the post-condition. |

### `request_warrant` — **paid** (bond must be funded)

_Open a bonded warrant_

Opens a bonded warrant for the given action and has KeeperHub execute it. Paid: the bond must be funded via x402 before the warrant opens. Returns the warrantId, the executionId and the conditionHash / actionHash commitments. If the post-condition holds, the bond comes back; otherwise it goes to the beneficiary. The bond is derived from the calldata — it is not negotiable.

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `actionSpec` | object | yes | The transaction to execute. Accepts neither category nor notional: both are derived from the calldata, never declared. |
| `beneficiary` | string | yes | Address that receives the bond if the post-condition is violated — the owner of the capital, never the agent. |

### `get_warrant` — free

_Read a warrant and its verdict_

Returns a warrant, its status and — once it is settled — the full verdict with the checks[] detail: one row per check, including the ones that pass, plus the exact block of evaluation. That is what makes a verdict replayable by a third party rather than taken on trust.

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `warrantId` | string | yes | Warrant identifier, as returned by request_warrant. |

### `list_warrants` — free

_List an agent warrants and statistics_

Lists an agent's warrants along with their aggregated statistics: number honored, number slashed, total bonded, honor rate. Filterable by status, category and time window. Use it to answer "what is this agent's track record?" without reading the chain.

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `agent` | string | yes | Agentic wallet whose warrants are being listed. |
| `status` | string | no | Keep only the warrants in this status. |
| `category` | string | no | After-the-fact filter on the derived category. Cannot be declared at opening time. |
| `since` | integer | no | Lower bound on openedAt, in Unix seconds. |
| `until` | integer | no | Upper bound on openedAt, in Unix seconds. |
| `limit` | integer | no | Maximum number of warrants returned (default 20). |
| `cursor` | string | no | Pagination cursor returned by a previous call. |
<!-- END GENERATED: tools -->

## What Warrant does not do

Warrant guarantees **outcome conformance, not decision quality**. Post-conditions
are strictly onchain-verifiable: balance deltas, allowance, health factor, nonce,
emitted event. It does not judge whether a decision was wise — that is
undecidable. Do not tell the user a bonded action is a *good* action; tell them
it is an action whose stated outcome is now backed by money.

---

Tool definitions above are generated from the Warrant single source of truth,
manifest `sha256:e81c9db86cf17732d642ef326d2af8ee6a8d172f63bef68a403cdad28f92786e`. If a tool here disagrees with what the Gateway
serves, this skill is stale — `clawhub update @warrant/warrant`.
