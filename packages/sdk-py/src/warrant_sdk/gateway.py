"""The Gateway interface, as the adapters see it.

This is the **only** dependency of the four tools. Neither the tools nor the
framework adapters know about HTTP, base64 or ``PAYMENT-REQUIRED`` headers, which
is what makes them testable without a network.

The counterpart is deliberate: a Gateway implementation must translate its HTTP
402 into an explicit :class:`RequestWarrantResult` with
``status="payment-required"`` rather than raising. A payment requirement is not an
error — it is a normal step of the protocol, and modelling it as an exception
pushes every caller into flow control by ``except``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

__all__ = ["GatewayClient", "RequestWarrantResult"]


@dataclass(frozen=True)
class RequestWarrantResult:
    """Two outcomes, one shape.

    Attributes:
        status: ``"payment-required"`` or ``"opened"``.
        payment_required: The x402 challenge, to be handed to a signer as-is.
        warrant: The opened warrant — ``warrantId``, ``executionId``,
            ``conditionHash``, ``actionHash``, ``expiry``.
        settlement: The x402 settlement receipt, when the payment rail was used.
    """

    status: str
    payment_required: dict[str, Any] | None = None
    warrant: dict[str, Any] | None = None
    settlement: dict[str, Any] | None = None


class GatewayClient(Protocol):
    """The four calls a Gateway must serve. Nothing more.

    ``request_warrant`` is the only one that takes a payment, because it is the
    only paid tool — an asymmetry that should be visible in the signature rather
    than hidden in a flag.
    """

    def quote(self, request: dict[str, Any]) -> dict[str, Any]:
        """Price an action. Free, and commits nothing."""
        ...

    def request_warrant(
        self,
        request: dict[str, Any],
        payment: dict[str, Any] | None = None,
        *,
        warrant_nonce: str | None = None,
    ) -> RequestWarrantResult:
        """Open a bonded warrant.

        Args:
            request: ``{"actionSpec": …, "beneficiary": …}``.
            payment: An x402 ``PaymentPayload``. Omit it to receive the challenge.
            warrant_nonce: The warrant nonce announced in the 402 challenge. It
                must travel back unchanged with the payment: it determines the
                warrant id, which enters the ``termsHash`` the EIP-3009
                authorization carries as its nonce. Guessing a new one produces a
                different ``termsHash`` than the one signed, and the escrow
                reverts with ``TermsMismatch()``.
        """
        ...

    def get_warrant(self, warrant_id: str) -> dict[str, Any] | None:
        """Read a warrant. ``None`` — not an exception — when it does not exist."""
        ...

    def list_warrants(self, query: dict[str, Any]) -> dict[str, Any]:
        """List an agent's warrants with aggregate statistics."""
        ...
