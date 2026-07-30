"""Actionable errors.

Every error a caller can see carries a ``hint`` and a documentation link, because
an agent that receives ``invalid input`` can correct nothing, while an agent that
receives ``$.actionSpec.calldata: expected hex calldata`` corrects itself on the
next turn.

The hints are **not** written here. They come from ``ERROR_CATALOG``, which is
generated from ``packages/sdk-ts/src/errors.ts`` — the same advice, word for word,
whichever language the adapter is written in.
"""

from __future__ import annotations

from typing import Any

from ._generated import ERROR_CATALOG

__all__ = ["WarrantError", "WarrantPaymentRequired", "ERROR_CODES"]

#: The known codes, in the order of the generated catalogue.
ERROR_CODES: tuple[str, ...] = tuple(ERROR_CATALOG)


class WarrantError(Exception):
    """A Warrant failure with everything needed to fix it.

    Args:
        code: One of :data:`ERROR_CODES`. Unknown codes raise :class:`KeyError`,
            deliberately: an invented code would ship without a hint or a doc
            link, which is the one thing this class exists to prevent.
        message: What went wrong, in one sentence.
        hint: What to do next. Defaults to the catalogue entry for ``code``.
        field: JSON path of the offending field, e.g. ``$.actionSpec.calldata``.
        details: Anything a caller may want to inspect programmatically.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        hint: str | None = None,
        field: str | None = None,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        entry = ERROR_CATALOG[code]
        self.code = code
        self.message = message
        self.hint = hint if hint is not None else entry["hint"]
        self.docs = entry["docs"]
        self.field = field
        self.details = details

    def to_json(self) -> dict[str, Any]:
        """Wire form, identical in shape to ``WarrantError.toJSON()`` in TypeScript."""
        error: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "hint": self.hint,
            "docs": self.docs,
        }
        if self.field is not None:
            error["field"] = self.field
        if self.details is not None:
            error["details"] = self.details
        return {"error": error}

    def __str__(self) -> str:  # pragma: no cover — debugging convenience
        where = f" ({self.field})" if self.field else ""
        return f"[{self.code}]{where} {self.message} — {self.hint}"


class WarrantPaymentRequired(Exception):
    """Raised only by the convenience wrappers, never by :meth:`WarrantClient.call`.

    A payment requirement is **not** a domain error: it is step 2 of the x402
    transport. ``call()`` therefore returns it as an outcome, so that an agent can
    read the amount and decide. The typed wrappers
    (:meth:`WarrantClient.open_warrant` and friends) have no way to return two
    shapes, so they raise this instead — which is also why they are not what the
    framework adapters use.
    """

    def __init__(self, payment_required: dict[str, Any]) -> None:
        accepts = payment_required.get("accepts") or [{}]
        amount = accepts[0].get("amount", "?")
        super().__init__(
            f"Bond of {amount} atomic units must be funded before the warrant can open. "
            "Pass a signer to WarrantClient(private_key=...) or settle the "
            "PaymentRequired yourself and replay the call."
        )
        self.payment_required = payment_required
