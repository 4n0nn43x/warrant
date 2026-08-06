"""An in-memory Warrant Gateway, so the examples run before you have anything.

Two uses, and the second matters as much as the first:

* it is the double the tests run against, so they need neither network nor a
  running Gateway;
* it lets a builder see the four tools work **before** wiring KeeperHub, an RPC, a
  faucet and an escrow. The DX target is "zero to a warrant in under five
  minutes", and most of those five minutes usually go into standing up a backend
  only to discover the tool was not the one you thought.

What it does **not** do is settle money. No chain is touched, no USDC moves. What
it does do faithfully — and this is the whole reason it exists rather than a stub
that accepts anything — is the payment handshake:

* it answers 402 with a real x402 v2 ``PaymentRequired`` carrying the
  ``warrant/commitment`` extension and all six terms;
* it **recovers the signer** from the EIP-712 signature. A client that signed
  ``TransferWithAuthorization`` — the x402 ``exact`` default — recovers to a
  different address and is rejected here, with an explanation, instead of reverting
  onchain an hour later with ``FiatTokenV2: invalid signature``;
* it recomputes ``termsHash`` and refuses an authorization whose nonce does not
  equal it, exactly as ``WarrantEscrow`` does;
* it requires the warrant nonce to travel back in the request body, exactly as the
  real Gateway does.

It shares :func:`terms_hash_of` and :func:`warrant_id_of` with the client, so what
the examples prove is that the protocol is wired correctly — right typehash, nonce
echoed, terms round-tripped. That the hashes match the *contract* is proven
elsewhere, by the Solidity and TypeScript test suites.

Unlike the real Gateway, this one settles immediately: a warrant comes back
``Honored`` with its ``checks[]`` filled, so the example can show a verdict in one
run. A real settlement waits for the evaluation block.

Usage:

    python -m mock_gateway --port 8402
    python examples/mock_gateway.py --port 8402
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from warrant_sdk.x402 import (
    RECEIVE_AUTHORIZATION_TRANSFER_METHOD,
    RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE,
    RECEIVE_WITH_AUTHORIZATION_TYPES,
    X402_VERSION,
    terms_hash_of,
    warrant_id_of,
)

# Base Sepolia, the real values: the only EVM chain the public x402 facilitator
# serves. An example running on invented addresses would teach the reader invented
# addresses.
CHAIN_ID = 84532
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
ESCROW = "0x3ae9ad53686383c80889F550065e810f72c2ff4e"
BENEFICIARY = "0x000000000000000000000000000000000000dEaD"

#: Selector → category and rate. The registry's principle, in miniature.
CATEGORIES: dict[str, tuple[str, int]] = {
    "0xa9059cbb": ("erc20.transfer", 50),
    "0x095ea7b3": ("erc20.approve", 150),
    "0x573ade81": ("aavev3.repay", 25),
    "0x617ba037": ("aavev3.supply", 25),
    "0x69328dec": ("aavev3.withdraw", 100),
    "0xa415bcad": ("aavev3.borrow", 200),
}


def _keccak_json(value: Any) -> str:
    """``keccak256`` of a canonical JSON form.

    Close to RFC 8785 but not it: keys are sorted by code point rather than UTF-16
    code unit, which coincides for every key we use. The mock only needs to be
    self-consistent; ``@warrant/core`` owns the real canonicalisation.
    """
    from eth_utils import keccak

    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "0x" + keccak(canonical.encode("utf-8")).hex()


def _notional_from_calldata(calldata: str) -> int:
    """Notional derived from the calldata — never declared.

    Returned in the same unit as the real Gateway: **USD in 1e6 fixed point**, the
    atomic unit of USDC. ``1_000_000`` therefore means one dollar, and a client
    that divides by ten to get dollars is wrong by six orders of magnitude — which
    is exactly why this mock must not use a friendlier unit than the real thing.

    A deliberate approximation: read the last 32-byte word and assume a six-decimal
    token priced at 1 USD. The real classifier ABI-decodes the arguments and reads
    the price from the registry. The point being demonstrated is the same either
    way — the value comes from the calldata, not from the request.
    """
    body = calldata[10:]
    if len(body) < 64:
        return 0
    return int(body[-64:], 16)


def _dest_from_calldata(calldata: str) -> str:
    """First address argument of the calldata, or the zero address.

    ``transfer(to, amount)`` and ``approve(spender, amount)`` both put it first.
    The committed post-condition needs it: what a bond guarantees is that *this*
    account's balance moved, and an account read from anywhere but the calldata
    would not be the account the action touches.
    """
    body = calldata[10:]
    if len(body) < 64:
        return "0x" + "00" * 20
    return "0x" + body[24:64]


def _usd(atomic: int) -> str:
    """``1_000_000`` → ``1.000000``. Same rendering as the real Gateway's rationale."""
    return f"{atomic // 1_000_000}.{atomic % 1_000_000:06d}"


def _check_row(check: dict[str, Any]) -> dict[str, Any]:
    """One verdict row per check, in the shape the real Settler writes.

    ``expected`` is a sentence, not a field: what makes a verdict auditable is that
    a third party can read *what was required* without holding the ConditionSpec.
    Rows are emitted for the checks that **pass** too — a verdict showing only the
    failing check cannot be replayed.
    """
    kind = check["kind"]
    if kind == "erc20_balance_delta":
        expected = (
            f"sum(Transfer) for account={check['account']} on token={check['token']} "
            f"{check['op']} {check['value']}"
        )
        observed = f"{check['value']} (in={check['value']}, out=0, transfers=1)"
    elif kind == "calldata_matches_commitment":
        expected = f"actionHash of the executed tx eq {check['actionHash']}"
        observed = str(check["actionHash"])
    else:  # pragma: no cover — the mock only commits to two kinds of check
        expected = json.dumps(check, sort_keys=True)
        observed = expected
    return {"kind": kind, "expected": expected, "observed": observed, "pass": True}


class MockGateway:
    """Gateway state: a policy, and the warrants opened so far."""

    def __init__(
        self,
        *,
        min_bond: int = 1_000_000,
        max_bond: int = 100_000_000,
        duration: int = 1800,
        beneficiary: str = BENEFICIARY,
        pay_to: str = ESCROW,
        asset: str = USDC,
        asset_name: str = "USDC",
        asset_version: str = "2",
        resource_url: str = "http://127.0.0.1:8402/v1/warrants",
    ) -> None:
        self.min_bond = min_bond
        self.max_bond = max_bond
        self.duration = duration
        self.beneficiary = beneficiary
        self.pay_to = pay_to
        self.asset = asset
        self.asset_name = asset_name
        self.asset_version = asset_version
        self.resource_url = resource_url
        self.warrants: dict[str, dict[str, Any]] = {}
        #: What the Gateway actually received — used to prove input stripping: a
        #: `category` sent by a client never arrives here.
        self.seen: list[dict[str, Any]] = []
        self._nonces: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    # ── tarification ─────────────────────────────────────────────────────────

    def price(self, action_spec: dict[str, Any]) -> dict[str, Any]:
        """Price an action, with the real Gateway's formula and the real units.

        ``bond = clamp(minBond, riskBps × notionalUSD, maxBond)``, every amount in
        atomic units. The formula is copied from ``packages/core/src/risk.ts``
        rather than simplified: a mock whose bond does not move with the notional
        would teach a builder that the bond is a constant.
        """
        calldata = action_spec.get("calldata", "")
        selector = calldata[:10].lower()
        category, risk_bps = CATEGORIES.get(selector, ("unknown", 500))
        notional = _notional_from_calldata(calldata)
        raw = notional * risk_bps // 10_000
        bond = min(max(raw, self.min_bond), self.max_bond)
        action_hash = _keccak_json(action_spec)
        dest = _dest_from_calldata(calldata)
        condition_spec = {
            "version": 1,
            "chainId": action_spec.get("chainId"),
            "evaluateAt": "tx+1",
            "confirmations": 3,
            # `op` / `value`, like the `@warrant/core` DSL — not a `min` invented
            # here: an example that renames a DSL field teaches the reader a DSL
            # that does not exist.
            "checks": [
                {"kind": "calldata_matches_commitment", "actionHash": action_hash},
                {
                    "kind": "erc20_balance_delta",
                    "token": action_spec.get("target"),
                    "account": dest,
                    "op": "gte",
                    "value": str(notional),
                },
            ],
        }
        clamp_note = (
            f" (minBond floor {_usd(self.min_bond)} applied)"
            if bond != raw and bond == self.min_bond
            else f" (maxBond ceiling {_usd(self.max_bond)} applied)"
            if bond != raw
            else ""
        )
        return {
            "category": category,
            "bond": str(bond),
            "riskBps": risk_bps,
            # Atomic, 1e6 = 1 USD — the real Gateway's unit. See
            # `_notional_from_calldata`.
            "notionalUSD": str(notional),
            "registryRef": action_spec.get("registryRef"),
            "conditionSpec": condition_spec,
            "conditionHash": _keccak_json(condition_spec),
            "actionHash": action_hash,
            "rationale": (
                f"{category}: {risk_bps} bps × {_usd(notional)} USD of notional derived "
                f"from the calldata = {_usd(raw)} USD{clamp_note}."
            ),
        }

    # ── 402 ──────────────────────────────────────────────────────────────────

    def challenge(self, priced: dict[str, Any], *, error: str | None = None) -> dict[str, Any]:
        """Build the ``PaymentRequired``, terms included.

        The terms are published because the agent signs them *by* signing the
        payment: the EIP-3009 nonce is their hash. ``warrantId`` is not announced
        and cannot be — it depends on the address that will sign, which only the
        client knows.
        """
        import secrets

        warrant_nonce = "0x" + secrets.token_bytes(32).hex()
        with self._lock:
            self._nonces[warrant_nonce] = priced

        return {
            "x402Version": X402_VERSION,
            "error": error or "PAYMENT-SIGNATURE header is required",
            "resource": {
                "url": self.resource_url,
                "description": f"Bond for a KeeperHub-executed {priced['category']} action",
                "mimeType": "application/json",
            },
            "accepts": [
                {
                    "scheme": "exact",
                    "network": f"eip155:{CHAIN_ID}",
                    "amount": priced["bond"],
                    "asset": self.asset,
                    "payTo": self.pay_to,
                    "maxTimeoutSeconds": 60,
                    "extra": {
                        "name": self.asset_name,
                        "version": self.asset_version,
                        # `eip3009-receive`, not `eip3009`: the latter designates
                        # `transferWithAuthorization` in the x402 spec, and
                        # announcing it here would make a conformant client sign
                        # the wrong typehash. Same value as the real Gateway
                        # (`DEFAULT_TRANSFER_METHOD` in server/src/x402.ts).
                        "assetTransferMethod": RECEIVE_AUTHORIZATION_TRANSFER_METHOD,
                        # Always emitted: this is the only piece of information in
                        # the 402 that cannot be guessed, and omitting it would
                        # leave the client on the `exact` scheme's default, which is
                        # the wrong one.
                        "primaryType": RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE,
                    },
                }
            ],
            "extensions": {
                "warrant/commitment": {
                    "info": {
                        "category": priced["category"],
                        "nonce": warrant_nonce,
                        "beneficiary": self.beneficiary,
                        "bond": priced["bond"],
                        "conditionHash": priced["conditionHash"],
                        "actionHash": priced["actionHash"],
                        "duration": self.duration,
                        "escrow": self.pay_to,
                        "warrantId": "keccak256(abi.encode(agent, nonce, actionHash))",
                        "authorizationNonce": (
                            "keccak256(abi.encode(warrantId, beneficiary, bond, "
                            "conditionHash, actionHash, duration))"
                        ),
                        "note": (
                            "the EIP-3009 authorization nonce must equal authorizationNonce, "
                            "and the signed type is ReceiveWithAuthorization — not "
                            "TransferWithAuthorization. Echo `nonce` back in the request body."
                        ),
                    }
                }
            },
        }

    # ── ouverture ────────────────────────────────────────────────────────────

    def open_warrant(
        self, body: dict[str, Any], payment: dict[str, Any]
    ) -> tuple[int, dict[str, Any], dict[str, Any] | None]:
        """Verify the payment and open the warrant.

        Returns:
            ``(status, body, settlement)``. A 402 body is the re-issued challenge
            with its ``error`` field explaining the refusal — which is how x402
            reports a rejected payment: not a 400, a new 402.
        """
        action_spec = body.get("actionSpec") or {}
        priced = self.price(action_spec)

        warrant_nonce = body.get("nonce")
        if warrant_nonce is None:
            return (
                400,
                {
                    "type": "urn:warrant:problem:missing_nonce",
                    "title": "Warrant nonce absent",
                    "status": 400,
                    "detail": (
                        "the `nonce` field from the 402 (warrant/commitment extension) must "
                        "come back with the payment: it determines the warrant id, which "
                        "enters the termsHash the EIP-3009 authorization carries as its nonce"
                    ),
                },
                None,
            )

        auth = (payment.get("payload") or {}).get("authorization") or {}
        signature = (payment.get("payload") or {}).get("signature")
        if not auth or not signature:
            return 402, self.challenge(priced, error="malformed_payload: no EIP-3009 authorization"), None

        # 1. The signature. This is where the wrong typehash gets caught.
        recovered = self._recover(auth, signature)
        if recovered is None or recovered.lower() != str(auth.get("from", "")).lower():
            return (
                402,
                self.challenge(
                    priced,
                    error=(
                        "invalid_signature: the signature does not recover to "
                        f"authorization.from ({auth.get('from')}); it recovers to {recovered}. "
                        "The signed EIP-712 type must be ReceiveWithAuthorization, not "
                        "TransferWithAuthorization — the two carry identical fields and "
                        "different typehashes, so a wrong-type signature is only detectable "
                        "by recovery failing."
                    ),
                ),
                None,
            )

        agent = recovered.lower()

        # 2. The amount. Exactly equal: this is the only point where the bond is
        #    actually constrained, the rest is merely transport.
        if int(auth.get("value", -1)) != int(priced["bond"]):
            return (
                402,
                self.challenge(
                    priced,
                    error=f"amount_mismatch: authorization of {auth.get('value')} for a required bond of {priced['bond']}",
                ),
                None,
            )

        # 3. The nonce equals the termsHash. The contract redoes this check and it
        #    is the authoritative one; we redo it here because an onchain revert
        #    does not say *which* term diverged, whereas we know all six.
        warrant_id = warrant_id_of(agent, warrant_nonce, priced["actionHash"])
        expected = terms_hash_of(
            warrant_id=warrant_id,
            beneficiary=self.beneficiary,
            bond=priced["bond"],
            condition_hash=priced["conditionHash"],
            action_hash=priced["actionHash"],
            duration=self.duration,
        )
        if str(auth.get("nonce", "")).lower() != expected.lower():
            return (
                402,
                self.challenge(
                    priced,
                    error=(
                        f"terms_mismatch: the authorization nonce ({auth.get('nonce')}) is not "
                        f"the termsHash of the terms served ({expected}). Terms: "
                        f"id={warrant_id}, beneficiary={self.beneficiary}, bond={priced['bond']}, "
                        f"conditionHash={priced['conditionHash']}, actionHash={priced['actionHash']}, "
                        f"duration={self.duration}"
                    ),
                ),
                None,
            )

        opened_at = int(time.time())
        # Immediate settlement: the mock has no evaluation block to wait for. A
        # real Gateway leaves the warrant `Open` and the settlement daemon decides.
        checks = [_check_row(check) for check in priced["conditionSpec"]["checks"]]
        view = {
            "warrantId": warrant_id,
            "agent": agent,
            "beneficiary": self.beneficiary,
            "bond": priced["bond"],
            "conditionHash": priced["conditionHash"],
            "actionHash": priced["actionHash"],
            "fundingRef": auth["nonce"],
            "expiry": opened_at + self.duration,
            "openedAt": opened_at,
            "status": 2,  # Honored
            "category": priced["category"],
            "executionId": f"exec_{len(self.warrants) + 1}",
            "actionSpec": action_spec,
            "conditionSpec": priced["conditionSpec"],
            "verdict": {
                "verdict": "honored",
                "evaluatedAtBlock": str(20_000_000 + len(self.warrants)),
                "rpcUrl": "https://sepolia.base.org",
                "settlementTx": "0x" + "ab" * 32,
            },
            "checks": checks,
        }
        with self._lock:
            self.warrants[warrant_id] = view

        warrant = {
            "warrantId": warrant_id,
            "executionId": view["executionId"],
            "conditionHash": priced["conditionHash"],
            "actionHash": priced["actionHash"],
            "expiry": view["expiry"],
            "bond": priced["bond"],
            "category": priced["category"],
            "fundingRef": auth["nonce"],
            "agent": agent,
            "beneficiary": self.beneficiary,
        }
        settlement = {
            "success": True,
            "transaction": "0x" + "ab" * 32,
            "network": f"eip155:{CHAIN_ID}",
            "payer": agent,
            "amount": priced["bond"],
        }
        return 200, warrant, settlement

    def _recover(self, auth: dict[str, Any], signature: str) -> str | None:
        from eth_account import Account
        from eth_account.messages import encode_typed_data

        try:
            signable = encode_typed_data(
                domain_data={
                    "name": self.asset_name,
                    "version": self.asset_version,
                    "chainId": CHAIN_ID,
                    "verifyingContract": self.asset,
                },
                message_types=RECEIVE_WITH_AUTHORIZATION_TYPES,
                message_data={
                    "from": auth["from"],
                    "to": auth["to"],
                    "value": int(auth["value"]),
                    "validAfter": int(auth["validAfter"]),
                    "validBefore": int(auth["validBefore"]),
                    "nonce": bytes.fromhex(str(auth["nonce"]).removeprefix("0x")),
                },
            )
            return str(Account.recover_message(signable, signature=bytes.fromhex(signature.removeprefix("0x"))))
        except Exception:  # noqa: BLE001 — an unreadable signature is a refusal, not a crash
            return None

    def list_warrants(self, query: dict[str, str]) -> dict[str, Any]:
        agent = (query.get("agent") or "").lower()
        found = [w for w in self.warrants.values() if w["agent"].lower() == agent]
        if query.get("category"):
            found = [w for w in found if w.get("category") == query["category"]]
        if query.get("status"):
            wanted = ("None", "open", "honored", "slashed", "reclaimed").index(query["status"])
            found = [w for w in found if w["status"] == wanted]

        def count(status: int) -> int:
            return len([w for w in found if w["status"] == status])

        honored, slashed = count(2), count(3)
        settled = honored + slashed
        return {
            "warrants": found[: int(query.get("limit") or 20)],
            "stats": {
                "total": len(found),
                "open": count(1),
                "honored": honored,
                "slashed": slashed,
                "reclaimed": count(4),
                "totalBonded": str(sum(int(w["bond"]) for w in found)),
                "totalSlashed": str(sum(int(w["bond"]) for w in found if w["status"] == 3)),
                "honorRateBps": 0 if settled == 0 else round(honored / settled * 10_000),
            },
        }


# ─────────────────────────────────────────────────────────────────────────────
# Le serveur HTTP
# ─────────────────────────────────────────────────────────────────────────────

_OPENAPI = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "openapi.json"


def make_handler(gateway: MockGateway, *, quiet: bool = False) -> type[BaseHTTPRequestHandler]:
    """Build the request handler class bound to one gateway instance."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            if not quiet:
                sys.stderr.write("mock-gateway %s\n" % (fmt % args))

        def _send(self, status: int, body: Any, headers: dict[str, str] | None = None) -> None:
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/healthz":
                return self._send(200, {"ok": True, "now": int(time.time())})
            if parsed.path == "/openapi.json":
                # The real document, frozen by the generator from
                # `packages/server/src/openapi.ts`. Serving it here means
                # `GET /openapi.json` tells the truth even under the mock.
                return self._send(200, json.loads(_OPENAPI.read_text(encoding="utf-8")))
            if parsed.path.startswith("/v1/warrants/"):
                warrant_id = parsed.path.rsplit("/", 1)[-1]
                view = gateway.warrants.get(warrant_id)
                if view is None:
                    return self._send(
                        404,
                        {
                            "type": "urn:warrant:problem:not_found",
                            "title": "Unknown warrant",
                            "status": 404,
                        },
                    )
                return self._send(200, view)
            if parsed.path == "/v1/warrants":
                query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
                return self._send(200, gateway.list_warrants(query))
            return self._send(404, {"title": "Not found", "status": 404})

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"title": "Body is not JSON", "status": 400})

            path = urlparse(self.path).path
            gateway.seen.append({"path": path, "body": body})

            if path == "/v1/quote":
                priced = gateway.price(body.get("actionSpec") or {})
                return self._send(200, priced)

            if path == "/v1/warrants":
                header = _header(self.headers, "PAYMENT-SIGNATURE")
                if not header:
                    challenge = gateway.challenge(gateway.price(body.get("actionSpec") or {}))
                    # Body `{}`: all the information is in the header, as
                    # l'exige x402 v2.
                    return self._send(
                        402, {}, {"PAYMENT-REQUIRED": _b64(challenge)}
                    )
                try:
                    payment = json.loads(base64.b64decode(header).decode("utf-8"))
                except Exception:  # noqa: BLE001
                    challenge = gateway.challenge(
                        gateway.price(body.get("actionSpec") or {}),
                        error="malformed_payment_header: PAYMENT-SIGNATURE is not base64 JSON",
                    )
                    return self._send(402, {}, {"PAYMENT-REQUIRED": _b64(challenge)})

                status, payload, settlement = gateway.open_warrant(body, payment)
                if status == 402:
                    return self._send(402, {}, {"PAYMENT-REQUIRED": _b64(payload)})
                if status != 200:
                    return self._send(status, payload)
                headers = {"PAYMENT-RESPONSE": _b64(settlement)} if settlement else {}
                return self._send(200, payload, headers)

            return self._send(404, {"title": "Not found", "status": 404})

    return Handler


def _b64(value: Any) -> str:
    return base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")


def _header(headers: Any, name: str) -> str | None:
    for key in headers.keys():
        if key.lower() == name.lower():
            return headers[key]
    return None


def serve(
    *, host: str = "127.0.0.1", port: int = 8402, gateway: MockGateway | None = None, quiet: bool = False
) -> tuple[ThreadingHTTPServer, MockGateway]:
    """Start the server on a background thread and return it with its state.

    ``port=0`` binds a free port — which is what the tests use, so that a Gateway
    already running on 8402 does not make the suite fail for the wrong reason.
    """
    state = gateway or MockGateway()
    server = ThreadingHTTPServer((host, port), make_handler(state, quiet=quiet))
    state.resource_url = f"http://{host}:{server.server_port}/v1/warrants"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Warrant mock Gateway (no chain, no money)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8402)
    parser.add_argument("--beneficiary", default=BENEFICIARY)
    args = parser.parse_args(argv)

    gateway = MockGateway(beneficiary=args.beneficiary)
    server, _ = serve(host=args.host, port=args.port, gateway=gateway)
    sys.stderr.write(
        f"mock Gateway on http://{args.host}:{server.server_port}\n"
        f"  beneficiary {args.beneficiary}\n"
        f"  asset       {USDC} (chainId {CHAIN_ID})\n"
        "  no chain is touched, no money moves — signatures are verified, funds are not\n"
        "Ctrl-C to stop.\n"
    )
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
