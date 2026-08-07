# Security Policy

Warrant holds money. The escrow custodies stablecoin bonds, the Settler can seize
one and pay it to a third party, and neither has an upgrade path — `WarrantEscrow`
ships with no proxy, no governance and no emergency withdrawal. A finding here is
not a ticket, it is funds.

## Scope, and what is deliberately out of it

**In scope**

| | |
| :--- | :--- |
| `contracts/` | `WarrantEscrow.sol` — the only component that holds funds |
| `packages/core/` | post-condition DSL, JCS canonicalisation, classifier, risk pricing |
| `packages/server/` | the 402 Gateway, the evaluator, the settlement daemon, ERC-8004 writes |
| `packages/sdk-ts/`, `packages/sdk-py/` | the published SDKs, `warrant-sdk` on npm and PyPI |
| The hosted Gateway | `https://warrant.fyra.fun` |
| `ghcr.io/4n0nn43x/warrant` | the published image |

**Out of scope**

- The **pre-audit Ethereum Sepolia deployment** at
  [`0xadDC715B…de12`](https://sepolia.etherscan.io/address/0xadDC715B79Cb972d3a7f0dce5998CC141CaAde12).
  It is known vulnerable, kept only as a historical record, and the README says
  not to use it. Findings against it are already known.
- **Decision quality.** Warrant guarantees outcome conformance, not that an
  action was wise. Post-conditions are strictly onchain-verifiable — balance
  deltas, allowance, health factor, nonce, emitted event. "The agent made a bad
  trade but the post-condition held" is the documented boundary, not a bug.
- `contracts/lib/` — vendored OpenZeppelin. Report those upstream.

## Reporting

**Report privately.** Use GitHub's
[private vulnerability reporting](https://github.com/4n0nn43x/warrant/security/advisories/new)
on this repository. Do not open a public issue, and do not exploit a finding
against the live deployment beyond what is needed to demonstrate it.

Useful in a report: the invariant you believe is broken (they are numbered — I1
to I10 — in `contracts/test/WarrantEscrow.invariant.t.sol`), a failing test or a
transaction hash, and what an attacker gains.

| | |
| :--- | :--- |
| Acknowledgement | 72 hours |
| Initial assessment | 7 days |
| Fix or documented mitigation | 90 days, sooner if funds are at risk |

This is a single-maintainer project, not a company with an on-call rotation.
Those numbers are what one person can actually hold to; treat them as honest
rather than generous.

## Supported versions

| Version | Status |
| :--- | :--- |
| `master`, Base Sepolia deployment `0x3ae9ad53…ff4e` | Supported |
| Ethereum Sepolia deployments | **Not supported** — pre-audit, do not use |
| `warrant-sdk` / `warrant-core` 0.1.x | Supported |

Everything runs on **Base Sepolia**, a testnet, against Circle's real USDC
contract. No mainnet deployment exists. Do not place funds you care about behind
any of it.

## What has already been looked at

An internal audit is in [`audit/`](audit), with runnable proofs of concept. It
found two real issues, both fixed before the current deployment:

- **I10 was not enforced** by the contract, and the fuzzing invariant that
  claimed to verify it drew the two roles from disjoint pools — so it could never
  fail. `opener == settler` is now rejected in the constructor and in both
  setters, and the Gateway refuses to start on it.
- **Opener withdrawal authority**: funding and opening were separate, leaving a
  window of unattached balance an `opener` could award to itself. They are now
  atomic, and the agent is derived from the EIP-3009 signature rather than
  declared.

The escrow carries 99 tests and 13 stateful fuzzing invariants. **It has not had
an external audit.** That is the single most important sentence in this file.

## Verifying what you run

The published image is signed with cosign, keyless, and the identity flags are
the policy — without them `cosign verify` accepts any valid signature from
anyone:

```bash
cosign verify ghcr.io/4n0nn43x/warrant@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/4n0nn43x/warrant/\.github/workflows/.+@refs/tags/v.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Verdicts are verifiable without trusting this project at all. Every one publishes
its pinned block, its RPC and its full `checks[]`; `scripts/replay-verdict.sh`
re-reads the chain and recomputes the answer.
