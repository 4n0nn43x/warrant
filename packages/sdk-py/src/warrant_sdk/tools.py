"""The four tools, projected into Python.

Four, not fifteen: the catalogue is deliberately small, because an agent chooses
badly among fifteen tools.

Nothing here defines a schema or a description. Names, titles, descriptions and
JSON Schemas come from ``_generated.py``, which is emitted from
``packages/sdk-ts/src/tools.ts``. What *is* written here is the part that cannot be
generated: how to call the Gateway, and how the x402 payment loop behaves. That
loop lives in one place so that neither the HTTP client nor any framework adapter
has to reimplement it — the kind of duplication that makes five surfaces diverge.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from ._generated import MANIFEST_SHA256, TOOL_MANIFEST
from .errors import WarrantError
from .gateway import GatewayClient
from .x402 import PaymentSigner, commitment_terms

__all__ = [
    "MANIFEST_SHA256",
    "ToolOutcome",
    "WarrantTool",
    "WARRANT_TOOLS",
    "WARRANT_TOOL_NAMES",
    "warrant_tool_by_name",
    "run_tool",
    "run_tool_by_name",
]


@dataclass(frozen=True)
class ToolOutcome:
    """The result of a tool call.

    ``payment-required`` is not a domain error: it is step 2 of the x402
    transport. Adapters are free to present it as an error — MCP requires that —
    but the core does not.

    Attributes:
        kind: ``"ok"`` or ``"payment-required"``.
        data: The tool's result, when ``kind == "ok"``.
        settlement: The x402 settlement receipt, when a payment was made.
        payment_required: The x402 challenge, when ``kind == "payment-required"``.
    """

    kind: str
    data: Any = None
    settlement: dict[str, Any] | None = None
    payment_required: dict[str, Any] | None = None


@dataclass(frozen=True)
class WarrantTool:
    """One tool descriptor, framework-agnostic.

    Attributes:
        name: Wire name, e.g. ``quote_risk``.
        title: Short human-readable title.
        description: What the model reads to decide whether to call it.
        paid: ``True`` for ``request_warrant`` only: the bond must be funded.
        read_only: None of these tools mutate onchain state beyond the payment.
        input_model: Pydantic model for the arguments. Drops unknown keys.
        input_schema: JSON Schema draft-7, exactly as MCP's ``tools/list`` publishes it.
        output_schema: Minimal output contract — deliberately permissive.
    """

    name: str
    title: str
    description: str
    paid: bool
    read_only: bool
    input_model: type[BaseModel]
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]

    def parse_args(self, args: Any) -> dict[str, Any]:
        """Validate and **scrub** the arguments.

        The scrubbing is the security-relevant part: the returned mapping contains
        only keys declared by the schema, so a ``category`` slipped into the
        ``actionSpec`` reaches neither the classifier nor the ``actionHash``.

        Raises:
            WarrantError: ``invalid_action_spec`` when the offending field is
                inside the action, ``invalid_input`` otherwise. The distinction is
                not cosmetic — it selects which hint the agent reads, and only the
                first one says that category and notional are derived.
        """
        try:
            model = self.input_model.model_validate(args if args is not None else {})
        except ValidationError as err:
            issues = err.errors()
            paths = ["$." + ".".join(str(p) for p in issue["loc"]) for issue in issues]
            message = "; ".join(
                f"{path}: {issue['msg']}" for path, issue in zip(paths, issues, strict=True)
            )
            first = paths[0] if paths else "$"
            code = "invalid_action_spec" if first.startswith("$.actionSpec") else "invalid_input"
            raise WarrantError(
                code,
                message,
                field=first,
                details=[
                    {"field": path, "message": issue["msg"], "type": issue["type"]}
                    for path, issue in zip(paths, issues, strict=True)
                ],
            ) from err
        # `exclude_none` : un champ optionnel non fourni ne doit pas partir en
        # `null` sur le fil — le Gateway distingue absent et nul.
        return model.model_dump(mode="json", exclude_none=True)

    def run(
        self,
        client: GatewayClient,
        args: Any,
        *,
        payment: dict[str, Any] | None = None,
        warrant_nonce: str | None = None,
    ) -> ToolOutcome:
        """Execute the tool against a Gateway. Does not pay; see :func:`run_tool`."""
        parsed = self.parse_args(args)
        return _RUNNERS[self.name](client, parsed, payment, warrant_nonce)


# ─────────────────────────────────────────────────────────────────────────────
# Les quatre exécutions
# ─────────────────────────────────────────────────────────────────────────────

Runner = Callable[
    [GatewayClient, dict[str, Any], "dict[str, Any] | None", "str | None"], ToolOutcome
]


def _quote_risk(
    client: GatewayClient, parsed: dict[str, Any], _payment: Any, _nonce: Any
) -> ToolOutcome:
    return ToolOutcome(kind="ok", data=client.quote(parsed))


def _request_warrant(
    client: GatewayClient,
    parsed: dict[str, Any],
    payment: dict[str, Any] | None,
    warrant_nonce: str | None,
) -> ToolOutcome:
    result = client.request_warrant(parsed, payment, warrant_nonce=warrant_nonce)
    if result.status == "payment-required":
        return ToolOutcome(kind="payment-required", payment_required=result.payment_required)
    return ToolOutcome(kind="ok", data=result.warrant, settlement=result.settlement)


def _get_warrant(
    client: GatewayClient, parsed: dict[str, Any], _payment: Any, _nonce: Any
) -> ToolOutcome:
    view = client.get_warrant(parsed["warrantId"])
    if view is None:
        raise WarrantError(
            "warrant_not_found",
            f"No warrant under id {parsed['warrantId']}.",
            field="$.warrantId",
        )
    return ToolOutcome(kind="ok", data=view)


def _list_warrants(
    client: GatewayClient, parsed: dict[str, Any], _payment: Any, _nonce: Any
) -> ToolOutcome:
    return ToolOutcome(kind="ok", data=client.list_warrants(parsed))


_RUNNERS: dict[str, Runner] = {
    "quote_risk": _quote_risk,
    "request_warrant": _request_warrant,
    "get_warrant": _get_warrant,
    "list_warrants": _list_warrants,
}


def _build() -> tuple[WarrantTool, ...]:
    """Turn the generated manifest into descriptors.

    Fails at **import** time if the manifest gained a tool this module cannot run.
    A silently missing tool would surface later as a ``KeyError`` inside an agent
    trace, which is the worst place to discover it.
    """
    missing = [spec["name"] for spec in TOOL_MANIFEST if spec["name"] not in _RUNNERS]
    if missing:
        raise RuntimeError(
            f"The tool manifest declares {missing} with no runner in tools.py. "
            "Add one — the manifest is the source, this module follows it."
        )
    return tuple(
        WarrantTool(
            name=spec["name"],
            title=spec["title"],
            description=spec["description"],
            paid=spec["paid"],
            read_only=spec["read_only"],
            input_model=spec["input_model"],
            input_schema=spec["input_schema"],
            output_schema=spec["output_schema"],
        )
        for spec in TOOL_MANIFEST
    )


#: The four tools, in the order of the source: quote, warrant, read, history.
WARRANT_TOOLS: tuple[WarrantTool, ...] = _build()

WARRANT_TOOL_NAMES: tuple[str, ...] = tuple(tool.name for tool in WARRANT_TOOLS)


def warrant_tool_by_name(name: str) -> WarrantTool | None:
    """Look a tool up by its wire name."""
    for tool in WARRANT_TOOLS:
        if tool.name == name:
            return tool
    return None


# ─────────────────────────────────────────────────────────────────────────────
# La boucle de paiement — une seule fois, ici
# ─────────────────────────────────────────────────────────────────────────────


def run_tool(
    client: GatewayClient,
    tool: WarrantTool,
    args: Any,
    *,
    signer: PaymentSigner | None = None,
    max_payment_attempts: int = 1,
) -> ToolOutcome:
    """Run a tool, funding the bond when a signer is available.

    Args:
        signer: Omit it and a 402 comes back as an outcome, untouched. That is the
            right default for a read-only agent: nothing can spend by accident.
        max_payment_attempts: Bounded replays. An unbounded payment loop facing a
            server that answers 402 forever would empty an agent wallet with
            nobody watching.
    """
    outcome = tool.run(client, args)
    attempts = 0

    while outcome.kind == "payment-required" and signer is not None and attempts < max_payment_attempts:
        attempts += 1
        challenge = outcome.payment_required or {}
        terms = commitment_terms(challenge)
        _assert_beneficiary_matches(tool, args, terms)
        try:
            payment = signer.create_payment(challenge)
        except WarrantError:
            raise
        except Exception as err:  # noqa: BLE001 — un signataire tiers peut lever n'importe quoi
            raise WarrantError(
                "payment_invalid",
                f"The signer refused to sign: {err}",
                details=challenge,
            ) from err
        outcome = tool.run(client, args, payment=payment, warrant_nonce=str(terms["nonce"]))

    return outcome


def run_tool_by_name(
    client: GatewayClient,
    name: str,
    args: Any,
    *,
    signer: PaymentSigner | None = None,
    max_payment_attempts: int = 1,
) -> ToolOutcome:
    """Same, by tool name."""
    tool = warrant_tool_by_name(name)
    if tool is None:
        raise WarrantError(
            "invalid_input",
            f"Unknown tool: {name}.",
            hint=f"The available tools are {', '.join(WARRANT_TOOL_NAMES)}.",
        )
    if signer is None:
        signer = getattr(client, "signer", None)
    return run_tool(
        client, tool, args, signer=signer, max_payment_attempts=max_payment_attempts
    )


def _assert_beneficiary_matches(
    tool: WarrantTool, args: Any, terms: dict[str, Any]
) -> None:
    """Refuse to sign terms that name a beneficiary the caller did not ask for.

    The Gateway commits the beneficiary from **its own policy**, not the one in the
    request — and since the EIP-3009 nonce hashes the terms, signing the payment
    signs that beneficiary too. If the two disagree, the agent would be bonding in
    favour of an address it never chose. That is worth a refusal rather than a
    warning: the signature is the only moment where it can still be stopped.
    """
    if not tool.paid:
        return
    requested = (args or {}).get("beneficiary") if isinstance(args, dict) else None
    served = terms.get("beneficiary")
    if requested is None or served is None:
        return
    if str(requested).lower() == str(served).lower():
        return
    raise WarrantError(
        "payment_invalid",
        f"The Gateway commits the bond to beneficiary {served}, but the call asked for "
        f"{requested}. Signing would bond in favour of an address you did not choose.",
        hint=(
            "The beneficiary comes from the Gateway's policy, not from the request. "
            "Either call with the policy's beneficiary, or point WARRANT_BASE_URL at a "
            "Gateway whose policy matches. GET /openapi.json shows the deployment."
        ),
        field="$.beneficiary",
        details={"requested": requested, "committed": served},
    )
