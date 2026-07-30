# warrant-sdk

**An agent doesn't get permission to act. It buys a mandate, and it loses the mandate if it lied.**

Warrant for Python agents: the four Warrant tools as LangChain tools, CrewAI tools,
or a CLI. Your agent prices the bond for an onchain action, commits to the
post-condition that action must produce, and pays the bond over x402. If the
post-condition holds the bond comes back; if it does not, the bond goes to the
capital owner and the verdict is written to the ERC-8004 Reputation Registry.

```bash
pip install 'warrant-sdk[langchain]'    # or [crewai], or nothing for the CLI
```

Before the first PyPI release, that is `pip install -e 'packages/sdk-py[langchain]'`
from a checkout. Everything below is unchanged either way.

---

## Zero to a warrant, in about a minute

No chain, no faucet, no API key. Two terminals. Measured, cold cache: 24 s to
install the base package, under a second for the two calls that follow.

**Terminal 1** — a Gateway that verifies signatures for real but moves no money:

```bash
git clone <this repo> && cd packages/sdk-py
pip install -e .          # two dependencies; the mock Gateway needs nothing else
python examples/mock_gateway.py --port 8402
```

**Terminal 2** — price an action, then bond it:

```bash
# 1. What would this 1 USDC transfer cost to bond?  (free, commits nothing)
warrant call quote_risk '{
  "actionSpec": {
    "version": 1,
    "chainId": 84532,
    "target": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    "value": "0",
    "calldata": "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240",
    "registryRef": "0x0000000000000000000000000000000000000000000000000000000000000001"
  }
}'
```

```json
{
  "category": "erc20.transfer",
  "bond": "1000000",
  "riskBps": 50,
  "notionalUSD": "1000000",
  "registryRef": "0x0000000000000000000000000000000000000000000000000000000000000001",
  "conditionSpec": { "…": "the post-condition that will be committed" },
  "conditionHash": "0x7818f02c…",
  "actionHash": "0x2775546c…",
  "rationale": "erc20.transfer: 50 bps × 1.000000 USD of notional derived from the calldata = 0.005000 USD (minBond floor 1.000000 applied)."
}
```

**Every amount is atomic.** `notionalUSD: "1000000"` is one dollar, in USD fixed
point at 1e6 — the same unit as USDC, because that is the unit the registry prices
in. `bond` likewise. A client that renders `notionalUSD` as dollars is wrong by six
orders of magnitude, which is why the mock Gateway uses the real unit rather than a
friendlier one.

Now open the warrant. Any throwaway key will do against the mock — it signs, it
never spends:

```bash
export WARRANT_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
warrant call request_warrant '{
  "actionSpec": { … the same object, byte for byte … },
  "beneficiary": "0x000000000000000000000000000000000000dEaD"
}'
```

```json
{
  "warrantId": "0x9b1b08ca…",
  "executionId": "exec_1",
  "conditionHash": "0x7818f02c…",
  "actionHash": "0x2775546c…",
  "expiry": 1785418413,
  "bond": "1000000",
  "fundingRef": "0xd367cdb4…",
  "agent": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "settlement": { "success": true, "payer": "0x70997970…", "amount": "1000000" }
}
```

`fundingRef` is the EIP-3009 authorization nonce, and that nonce *is* the hash of
the six committed terms — see below. Signing the payment signed the terms.

Then read the verdict, with one line per check — including the ones that passed,
because a verdict that only shows the failing check is not auditable:

```bash
warrant call get_warrant '{"warrantId": "0x9b1b08ca…"}'
warrant call list_warrants '{"agent": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"}'
```

```json
{
  "status": 2,
  "verdict": { "verdict": "honored", "evaluatedAtBlock": "20000000", "settlementTx": "0xabab…" },
  "checks": [
    { "kind": "calldata_matches_commitment", "expected": "actionHash of the executed tx eq 0x2775546c…", "pass": true },
    { "kind": "erc20_balance_delta", "expected": "sum(Transfer) for account=0x…dead on token=0x036cbd53… gte 1000000", "pass": true }
  ]
}
```

The mock settles immediately so that one run shows a verdict. A real Gateway leaves
the warrant `Open` (status `1`) with `checks: []` until the Settler evaluates it at
the pinned block — that difference is the only place where the mock lies, and it
lies in the direction of being faster, not more permissive.

Run it without `WARRANT_PRIVATE_KEY` and `request_warrant` exits **2** with the
x402 challenge on stdout instead of failing — the bond amount, the asset, and the
terms you would be signing. That is not a degraded mode, it is the protocol.

## LangChain

```python
from langchain.agents import create_agent
from warrant_sdk.langchain import warrant_tools

agent = create_agent(
    model="anthropic:claude-opus-4-5",
    tools=warrant_tools(base_url="http://127.0.0.1:8402"),
    system_prompt=(
        "Before any onchain action, call quote_risk. Only open a warrant if the "
        "bond is under 10 USDC. Never claim an action is safe — say what "
        "post-condition it is bonded against."
    ),
)

result = agent.invoke({"messages": [{"role": "user", "content":
    "Bond a 1 USDC transfer on Base Sepolia to 0x…dEaD, beneficiary 0x…dEaD"}]})
```

Runnable version, with the mock Gateway started for you and no model key needed:

```bash
pip install -e '.[langchain]'
python examples/langchain_quickstart.py
```

It walks the four tools through the LangChain interface and ends by printing what
the Gateway actually received — which is how you can see the input scrubbing rather
than take it on faith:

```
── what the Gateway actually received ─────────────────────────────────
  /v1/quote        actionSpec keys: ['calldata', 'chainId', 'registryRef', 'target', 'value', 'version']
  /v1/warrants     actionSpec keys: ['calldata', 'chainId', 'registryRef', 'target', 'value', 'version']
  No `category`, no `notional` — the SDK scrubbed them before the request.
```

## CrewAI

```python
from crewai import Agent, Crew, Task
from warrant_sdk.crewai import warrant_tools

treasurer = Agent(
    role="Treasury operator",
    goal="Move funds only under a bonded mandate",
    backstory="Prices every action before executing it, and never negotiates a bond.",
    tools=warrant_tools(base_url="http://127.0.0.1:8402"),
)
```

```bash
pip install -e '.[crewai]'
python examples/crewai_quickstart.py
```

Real output of that command, abridged — the same four tools, wrapped in `BaseTool`
subclasses instead of `StructuredTool`s:

```
── the crew's toolbelt ────────────────────────────────────────────────
  QuoteRiskTool        quote_risk       free  args: QuoteRiskInput
  RequestWarrantTool   request_warrant  paid  args: RequestWarrantInput
  GetWarrantTool       get_warrant      free  args: GetWarrantInput
  ListWarrantsTool     list_warrants    free  args: ListWarrantsInput

── 3. get_warrant — the verdict ───────────────────────────────────────
  status 2 (2 = honored), 2 checks:
    ✓ calldata_matches_commitment
    ✓ erc20_balance_delta
```

Both adapters take the same arguments, share the same bridge (`_adapter.py`), and
return the tool result as JSON text. Switching framework changes nothing about how
Warrant is configured.

Neither example needs a model key. Set `ANTHROPIC_API_KEY` and each one adds a final
step where the model chooses the calls itself — optional on purpose: a quickstart
that cannot run without a paid API key is not a quickstart.

## Configuration

| variable | meaning |
| --- | --- |
| `WARRANT_BASE_URL` | Gateway root. Default `http://127.0.0.1:8402`. |
| `WARRANT_PRIVATE_KEY` | Agent key that signs the EIP-3009 bond authorization. Only `request_warrant` needs it; the three read tools spend nothing and need no key. |

Everything can also be passed explicitly, which is what you want in a server:

```python
warrant_tools(base_url=…, private_key=…, only=["quote_risk"])   # read-only agent
warrant_tools(signer=MyKmsSigner())                              # no key in the process
```

`only=["quote_risk"]` is the configuration where an agent can price risk but can
never open a warrant. Worth knowing it exists before you need it.

## Against a real Gateway

Same four commands, three differences worth knowing before you meet them as errors.
From the repo root:

```bash
set -a; . ./.env; set +a          # escrow, asset, policy, facilitator, KeeperHub
PORT=8402 pnpm --filter @warrant/server gateway
export WARRANT_BASE_URL=http://127.0.0.1:8402
```

**1. `registryRef` is pinned, not decorative.** The mock accepts any value; a real
Gateway refuses one that is not the keccak of the classification registry it is
actually serving, because a commitment made against another registry version is not
replayable. The placeholder from the walkthrough above gets you:

```json
{"error": {"code": "gateway_error", "message": "POST /v1/quote answered 422.",
  "details": {"type": "https://warrant.sh/problems/registry_mismatch",
    "declared": "0x00…01",
    "expected": "0x62bc8078d52fd768cfb96011df5011fdbd5832539586b997631e472ec979b90e"}}}
```

`details.expected` is the value to use — the recovery is one copy-paste, and it
works against any deployment without knowing anything about it in advance. It is
also the digest of `deployments/registry-<network>.json` if you have the checkout.

**2. `beneficiary` comes from the Gateway's policy.** Send the wrong one and the SDK
refuses to sign rather than bonding in favour of an address you did not choose — see
*Known divergences* below. `WARRANT_BENEFICIARY` in the deployment's environment is
the one it commits.

**3. The warrant opens `Open`, not `Honored`.** `request_warrant` returns once the
bond is escrowed and KeeperHub has accepted the execution; the verdict appears when
the Settler evaluates the post-condition at the pinned block. So `get_warrant`
immediately after an open shows `status: 1` and `checks: []`, and that is correct.
The Settler is a second process — `pnpm --filter @warrant/server settler` — and with
the Gateway alone the warrant stays `Open` until it expires and the bond is
reclaimable. Nothing to poll for on the client side; poll `get_warrant`, but on the
scale of the confirmation window, not of a request.

Measured end to end against Base Sepolia (escrow
`0x3ae9ad53686383c80889F550065e810f72c2ff4e`, real Circle USDC), with
`WARRANT_PRIVATE_KEY` set to a funded agent key:

```
$ time warrant call request_warrant @action.json
{ "warrantId": "0x034272c6…", "executionId": "gmi4cavqkmwzhbkpgbvwc",
  "bond": "200000", "fundingRef": "0x652f29d4…",
  "settlement": { "success": true, "transaction": "0x18de8be7…", "amount": "200000" } }
12.5 s total
```

Twelve of those seconds are the chain and KeeperHub. The other three calls are
local-network fast: 0.2 s each.

## Paying the bond: two things that break every other x402 client

Read this **before** you debug a signature. Both failures are silent.

### 1. The signed type is `ReceiveWithAuthorization`, not `TransferWithAuthorization`

Standard x402 `exact` implementations sign `TransferWithAuthorization`. Warrant's
escrow calls `receiveWithAuthorization`, deliberately: the `receive` variant
requires `to == msg.sender`, so no third party can submit your authorization to the
token first and burn the nonce out from under a legitimate open.

The two EIP-712 types carry the **same six fields** and hash to different
typehashes. Nothing in the payload records which one you signed. A wrong-type
signature is indistinguishable from a right one until the token rejects it — and
what you see then is a reverted transaction whose reason names nothing you sent:
`FiatTokenV2: invalid signature` from Circle's USDC, `InvalidSignature()` from
tokens that use custom errors.

The 402 challenge says so twice, and both fields matter:

```json
"extra": {
  "name": "USDC",
  "version": "2",
  "assetTransferMethod": "eip3009-receive",
  "primaryType": "ReceiveWithAuthorization"
}
```

`assetTransferMethod` is **not** the value the x402 `exact` scheme prescribes. The
spec says that field, *if present, MUST be* `"eip3009"` — and there `eip3009` means
`transferWithAuthorization`. Announcing it would therefore be false: a conformant
client would sign the wrong typehash. Warrant announces `"eip3009-receive"` as a
deliberate, documented extension, and `Eip3009Signer` refuses anything else —
including the bare `"eip3009"` — rather than falling back to a library default.

If you write your own signer, this is the one field not to be clever about. Measured
against the real Circle USDC on Base Sepolia (`eth_call` with `from` set to the
escrow, so `msg.sender == to` holds exactly as it does inside `open()`):

```
receiveWithAuthorization, ReceiveWithAuthorization signature  → 0x        (accepted)
receiveWithAuthorization, TransferWithAuthorization signature → reverted:
                                                 "FiatTokenV2: invalid signature"
```

Same six fields, same `nonce`, same signer, same amount. One works, the other gives
you a revert string that names nothing.

### 2. The authorization nonce is not random — it is the hash of the warrant terms

EIP-3009 signs six fields, none of which says *which warrant* is being funded. An
`opener` holding your authorization could once have opened terms of its own
choosing: another beneficiary, another post-condition, the maximum duration. The
escrow closes that by requiring

```
nonce == termsHash = keccak256(abi.encode(
    warrantId, beneficiary, bond, conditionHash, actionHash, duration))
warrantId = keccak256(abi.encode(agent, nonce, actionHash))
```

Because the nonce is inside the signed digest, signing the payment *is* signing the
terms. One signature, complete binding. The cost is that the client must know every
term before signing, so the Gateway publishes all of them in the 402 under
`extensions["warrant/commitment"].info` — and the warrant `nonce` it gives you must
travel back in the request body. Miss it and you get `missing_nonce`; compute the
hash wrong and you get `TermsMismatch()`.

`WarrantClient` does all of this. `warrant_sdk.x402.terms_hash_of` and
`warrant_id_of` are exported so you can do it yourself if you sign in a KMS.

## Two product rules that are in the schemas, not in the docs

**Category and notional are derived from the calldata, never declared.** No tool
accepts a `category` or a `notional` field. A `category` slipped into an
`actionSpec` is *dropped* — not rejected — before the request is hashed, so it
cannot reach the classifier or the `actionHash`:

```python
>>> from warrant_sdk import warrant_tool_by_name
>>> tool = warrant_tool_by_name("quote_risk")
>>> tool.parse_args({"actionSpec": {..., "category": "erc20.transfer"}})["actionSpec"].keys()
dict_keys(['version', 'chainId', 'target', 'value', 'calldata', 'registryRef'])
```

Dropped rather than rejected on purpose: rejecting would teach an agent that the
field exists somewhere, and it exists nowhere. (`list_warrants` does take a
`category` — as a filter over already-derived categories. Reading is not declaring.)

**A payment requirement is not an error.** `client.call("request_warrant", …)`
returns a `ToolOutcome` with `kind="payment-required"` carrying the challenge. The
framework adapters return it to the model as JSON so it can read the amount and
decide; only the typed helpers (`client.open_warrant`) raise, because a single
return type leaves them nowhere to put it.

## Where the tool definitions come from

Nothing in this package declares a tool. Names, titles, descriptions, argument
schemas and error hints are **generated** from
`packages/sdk-ts/src/tools.ts` — the same source the MCP server and the Vercel AI
SDK adapter project from. `src/warrant_sdk/_generated.py` is the output and carries
a `DO NOT EDIT` banner.

Generation, rather than reading `/openapi.json` at runtime, and the reasoning is
written out at the top of `codegen/emit.ts`. Two reasons in short: the OpenAPI
document describes the **HTTP** surface, so it has no tool names and no tool
descriptions — generating from it would mean retyping the descriptions in Python,
which is the exact bug being avoided; and building an agent would become a network
call, where a briefly silent Gateway yields not an error but an agent with **no
tools**, which is miserable to diagnose from a model trace.

What generation costs is that the artefact can go stale. That is paid for:

```bash
pnpm tsx packages/sdk-py/codegen/emit.ts --check    # exits 1 on any drift
```

`tests/test_codegen_drift.py` runs exactly that, so drift is a red CI rather than a
surprise in production. And `tests/test_openapi_conformance.py` cross-checks the
generated models against the Gateway's own OpenAPI document: two independent
projections of the same `ActionSpec`, compared field by field. That is the one
honest use of a sibling projection — a cross-check, never a source.

## Development

```bash
cd packages/sdk-py
uv venv && uv pip install -e '.[dev]' && uv run pytest    # or pip, if you prefer
pnpm tsx packages/sdk-py/codegen/emit.ts                  # after changing tools.ts
```

57 tests, no network, no chain, about 19 s — most of which is the drift check
re-running the TypeScript generator.

Adding a field to a tool schema in TypeScript and forgetting to regenerate makes
`pytest` fail with the first differing line. Verified by doing it: renaming
`quote_risk`'s title in `tools.ts` fails the drift test with

```
packages/sdk-py/src/warrant_sdk/_generated.py: line 34
      on disk:  MANIFEST_SHA256 = "sha256:9a3fc71a…"
      expected: MANIFEST_SHA256 = "sha256:b983f6a0…"
packages/sdk-py/tests/fixtures/manifest.json: line 7
skills/warrant/SKILL.md: line 181
```

— all three projections at once, each with the first differing line. Adding a JSON
Schema construct the emitter does not understand makes *generation* fail, with the
field path, rather than quietly turning the constraint into `Any`.

## Known divergences, stated rather than hidden

**`beneficiary` is an argument the Gateway overrides.** The tool schema makes it a
required argument of `request_warrant`, but the Gateway commits the beneficiary from
**its own policy** and ignores the one in the request. Since the EIP-3009 nonce
hashes the terms, signing would bond in favour of an address the caller never chose.
This SDK therefore **refuses to sign** when the two disagree, with a
`payment_invalid` error naming both. Verified against the live Gateway:

```
[payment_invalid] ($.beneficiary) The Gateway commits the bond to beneficiary
0x…beef, but the call asked for 0x…dEaD. Signing would bond in favour of an
address you did not choose.
```

Better a legible refusal than a warrant whose beneficiary is a surprise.

**`list_warrants.stats` field names differ between the schema and the deployment.**
The tool's output contract — generated, like everything else, from
`packages/sdk-ts/src/schemas.ts` — declares `totalBonded`, `totalSlashed` and
`honorRateBps`. The Gateway currently serves `bondHonoredTotal`, `bondSlashedTotal`
and `totalAtRisk` instead. The counts (`total`, `open`, `honored`, `slashed`,
`reclaimed`) agree. Nothing in this SDK validates tool output, so the extra fields
pass through untouched and the missing ones are simply absent; an MCP client that
enforces `outputSchema` strictly would reject the response. Read the counts, and
treat the money totals as deployment-specific until the two sides agree. The fix
belongs in the Gateway or in the schema — not here: a Python adapter that renamed
the fields to match would be a fifth spelling of the same object.

## Licence

MIT.
