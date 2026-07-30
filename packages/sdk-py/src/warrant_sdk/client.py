"""``WarrantClient`` — the Gateway's HTTP client, plus the x402 payment loop.

Two levels in one object, on purpose:

* it **implements** :class:`~warrant_sdk.gateway.GatewayClient` — bare transport,
  one HTTP call per method, no magic;
* it exposes :meth:`WarrantClient.call`, which runs a tool descriptor and replays
  it automatically with a payment when a signer is configured.

:meth:`call` is what the framework adapters consume: a LangChain or CrewAI agent
should not have to know the 402 protocol exists.

The transport is :mod:`urllib` from the standard library rather than ``httpx`` or
``requests``. A single dependency saved is not the reason; the reason is that this
package is installed by ``uvx`` inside an agent runtime, where every extra
transitive dependency is one more version conflict with whatever the host already
imported.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .errors import WarrantError, WarrantPaymentRequired
from .gateway import RequestWarrantResult
from .x402 import PaymentSigner, is_payment_required

__all__ = ["WarrantClient", "DEFAULT_BASE_URL", "normalize_warrant_view"]

#: The local Gateway, the one `pnpm --filter @warrant/server gateway` serves.
DEFAULT_BASE_URL = "http://127.0.0.1:8402"

#: v2 transport headers. The names changed since v1: `X-PAYMENT` no longer
#: exists, and accepting both would amount to accepting two payload formats under
#: a single name.
HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED"
HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE"
HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE"


def _b64_json(value: Any) -> str:
    return base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")


def _un_b64_json(value: str) -> Any:
    return json.loads(base64.b64decode(value.strip()).decode("utf-8"))


class WarrantClient:
    """Talks to a Warrant Gateway and, if it can, pays for the bond.

    Args:
        base_url: Gateway root. Defaults to ``$WARRANT_BASE_URL`` then to
            ``http://127.0.0.1:8402``.
        private_key: Agent key. Convenience shortcut for
            ``signer=Eip3009Signer(private_key)``; defaults to
            ``$WARRANT_PRIVATE_KEY``. Without a key, ``request_warrant`` stops at
            the 402 and returns the challenge instead of paying it.
        signer: Any :class:`~warrant_sdk.x402.PaymentSigner`. Takes precedence
            over ``private_key``, and is how you plug in a KMS or a remote signer.
        timeout: Per-request timeout, in seconds.
        max_payment_attempts: How many times a 402 may be replayed with a
            payment. Bounded on purpose: an unbounded loop against a server that
            answers 402 forever would drain an agent wallet with no human watching.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        private_key: str | None = None,
        signer: PaymentSigner | None = None,
        timeout: float = 30.0,
        headers: dict[str, str] | None = None,
        max_payment_attempts: int = 1,
    ) -> None:
        self.base_url = (base_url or os.environ.get("WARRANT_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.max_payment_attempts = max_payment_attempts
        self._headers = {"content-type": "application/json", "accept": "application/json"}
        if headers:
            self._headers.update(headers)

        key = private_key if private_key is not None else os.environ.get("WARRANT_PRIVATE_KEY")
        if signer is not None:
            self.signer: PaymentSigner | None = signer
        elif key:
            from .x402 import Eip3009Signer

            self.signer = Eip3009Signer(key)
        else:
            self.signer = None

    # ── transport ────────────────────────────────────────────────────────────

    def _request(
        self, method: str, path: str, *, body: Any = None, headers: dict[str, str] | None = None
    ) -> tuple[int, dict[str, str], Any]:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            url, data=data, method=method, headers={**self._headers, **(headers or {})}
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                return response.status, dict(response.headers), _maybe_json(raw)
        except urllib.error.HTTPError as err:
            # A 402 **is** a useful response: it carries the challenge in a
            # header. Letting it escape as an exception would force every caller
            # to catch an HTTP error in order to read a normal protocol state.
            raw = err.read().decode("utf-8", errors="replace")
            return err.code, dict(err.headers or {}), _maybe_json(raw)
        except urllib.error.URLError as err:
            raise WarrantError(
                "gateway_unreachable",
                f"Gateway unreachable at {url}: {err.reason}",
                details={"url": url},
            ) from err
        except TimeoutError as err:  # pragma: no cover — network-dependent
            raise WarrantError(
                "gateway_unreachable",
                f"Gateway timed out after {self.timeout}s at {url}.",
                details={"url": url},
            ) from err

    def _fail(self, status: int, path: str, body: Any) -> None:
        if status == 404:
            raise WarrantError("warrant_not_found", f"{path}: not found.", details=body)
        raise WarrantError("gateway_error", f"{path} answered {status}.", details=body)

    # ── GatewayClient ────────────────────────────────────────────────────────

    def quote(self, request: dict[str, Any]) -> dict[str, Any]:
        """``POST /v1/quote``. Free, unauthenticated, commits nothing."""
        status, _, body = self._request("POST", "/v1/quote", body=request)
        if status < 200 or status >= 300:
            self._fail(status, "POST /v1/quote", body)
        return body

    def request_warrant(
        self,
        request: dict[str, Any],
        payment: dict[str, Any] | None = None,
        *,
        warrant_nonce: str | None = None,
    ) -> RequestWarrantResult:
        """``POST /v1/warrants``, with or without a payment."""
        headers: dict[str, str] = {}
        if payment is not None:
            headers[HEADER_PAYMENT_SIGNATURE] = _b64_json(payment)

        body = dict(request)
        if warrant_nonce is not None:
            # The nonce announced by the 402, echoed back **unchanged**. Without
            # it the Gateway answers `missing_nonce`: it cannot guess the nonce
            # without computing a different warrantId, hence a different termsHash
            # from the one that was signed.
            body["nonce"] = warrant_nonce

        status, response_headers, response = self._request(
            "POST", "/v1/warrants", body=body, headers=headers
        )

        if status == 402:
            header = _header(response_headers, HEADER_PAYMENT_REQUIRED)
            challenge = _un_b64_json(header) if header else response
            if not is_payment_required(challenge):
                raise WarrantError(
                    "payment_invalid",
                    "The Gateway answered 402 without a usable x402 v2 PaymentRequired.",
                    details={"headers": response_headers, "body": response},
                )
            return RequestWarrantResult(status="payment-required", payment_required=challenge)

        if status < 200 or status >= 300:
            self._fail(status, "POST /v1/warrants", response)

        receipt = _header(response_headers, HEADER_PAYMENT_RESPONSE)
        return RequestWarrantResult(
            status="opened",
            warrant=response,
            settlement=_un_b64_json(receipt) if receipt else None,
        )

    def get_warrant(self, warrant_id: str) -> dict[str, Any] | None:
        """``GET /v1/warrants/{id}``. ``None`` on 404."""
        status, _, body = self._request("GET", f"/v1/warrants/{warrant_id}")
        if status == 404:
            return None
        if status < 200 or status >= 300:
            self._fail(status, f"GET /v1/warrants/{warrant_id}", body)
        return normalize_warrant_view(body)

    def list_warrants(self, query: dict[str, Any]) -> dict[str, Any]:
        """``GET /v1/warrants?…``."""
        params = {k: str(v) for k, v in query.items() if v is not None}
        path = f"/v1/warrants?{urllib.parse.urlencode(params)}"
        status, _, body = self._request("GET", path)
        if status < 200 or status >= 300:
            self._fail(status, "GET /v1/warrants", body)
        return body

    # ── outils ───────────────────────────────────────────────────────────────

    def call(self, name: str, args: Any) -> Any:
        """Run a tool by name, settling the bond if a signer is configured.

        Returns:
            A :class:`~warrant_sdk.tools.ToolOutcome`. Two kinds: ``"ok"`` with the
            data, or ``"payment-required"`` with the challenge. The second is not
            an error, which is why this returns rather than raises.
        """
        from .tools import run_tool_by_name

        return run_tool_by_name(self, name, args, max_payment_attempts=self.max_payment_attempts)

    # ── typed sugar, the normal route for application code ────────────────────

    def quote_risk(self, args: Any) -> dict[str, Any]:
        """Price an action. See ``quote_risk`` in the tool manifest."""
        return _unwrap(self.call("quote_risk", args))

    def open_warrant(self, args: Any) -> dict[str, Any]:
        """Open a bonded warrant. Raises :class:`WarrantPaymentRequired` with no signer."""
        return _unwrap(self.call("request_warrant", args))

    def read_warrant(self, args: Any) -> dict[str, Any]:
        """Read a warrant and its verdict."""
        return _unwrap(self.call("get_warrant", args))

    def history(self, args: Any) -> dict[str, Any]:
        """List an agent's warrants and statistics."""
        return _unwrap(self.call("list_warrants", args))


def _unwrap(outcome: Any) -> Any:
    if outcome.kind == "ok":
        return outcome.data
    raise WarrantPaymentRequired(outcome.payment_required)


def _header(headers: dict[str, str], name: str) -> str | None:
    """HTTP header lookup, case-insensitive as RFC 9110 requires."""
    lowered = name.lower()
    for key, value in headers.items():
        if key.lower() == lowered:
            return value
    return None


def _maybe_json(raw: str) -> Any:
    if raw == "":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # The body is not JSON — keep the raw text rather than lose the only
        # available clue about what answered.
        return raw


def normalize_warrant_view(raw: Any) -> dict[str, Any]:
    """Flatten the ``GET /v1/warrants/:id`` envelope.

    The Gateway serves ``{warrant, verdict, checks, actionSpec…}`` with a
    spelled-out ``status``, while the tool's output contract is flat and carries
    the integer of the Solidity enum. Translating here — at the transport boundary
    — keeps a framework adapter from having to know two shapes of the same object.
    An already-flat response passes through untouched, so the day the Gateway
    aligns there is nothing to remove.
    """
    if not isinstance(raw, dict):
        return raw
    nested = raw.get("warrant")
    if not isinstance(nested, dict):
        return raw

    view: dict[str, Any] = dict(nested)
    view["warrantId"] = nested.get("warrantId") or nested.get("id")
    view["status"] = _normalize_status(nested.get("status"))
    view["checks"] = raw["checks"] if isinstance(raw.get("checks"), list) else []
    view.pop("id", None)

    if raw.get("verdict"):
        view["verdict"] = raw["verdict"]
    execution = raw.get("execution")
    if isinstance(execution, dict) and execution.get("executionId") is not None:
        view["executionId"] = execution["executionId"]
    quote = raw.get("quote")
    if isinstance(quote, dict) and quote.get("category") is not None:
        view["category"] = quote["category"]
    for key in ("actionSpec", "conditionSpec"):
        if raw.get(key) is not None:
            view[key] = raw[key]
    return view


_STATUS_NAMES = ("None", "Open", "Honored", "Slashed", "Reclaimed")


def _normalize_status(status: Any) -> int:
    """``"Open"`` or ``1`` — both reach the integer of the Solidity enum."""
    if isinstance(status, bool):
        return 0
    if isinstance(status, int):
        return status
    try:
        return _STATUS_NAMES.index(str(status))
    except ValueError:
        return 0
