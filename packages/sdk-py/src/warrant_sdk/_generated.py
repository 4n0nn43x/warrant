# ═══════════════════════════════════════════════════════════════════════════
# GENERATED FILE — DO NOT EDIT BY HAND.
#
# Source:     packages/sdk-ts/src/tools.ts and schemas.ts, serialised by
#             packages/sdk-ts/src/manifest.ts.
# Regenerate: pnpm tsx packages/sdk-py/codegen/emit.ts
# Verify:     pnpm tsx packages/sdk-py/codegen/emit.ts --check
#
# Any manual edit will be overwritten, and `tests/test_codegen_drift.py` will
# fail before that happens: this is what guarantees the Python cannot diverge
# from the TypeScript. The descriptions below are copied verbatim from the single
# source of truth — correcting them here would make them lie, not improve them.
# ═══════════════════════════════════════════════════════════════════════════
"""Models and manifest generated from the TypeScript single source of truth.

Nothing here is written by hand. The Pydantic models carry `extra="ignore"`,
which reproduces the unknown-key stripping that Zod performs: a `category` or
`notional` field slipped into the arguments is **removed** before the call, so
it reaches neither the Classifier nor the `actionHash`.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

MANIFEST_VERSION = 1
JSON_SCHEMA_DIALECT = "draft-7"

#: sha256 of the manifest's canonical form. Identifies the revision of the single
#: source of truth this file came from; published by `warrant tools` and by the
#: OpenClaw skill so that a stale artifact can be spotted without reading code.
MANIFEST_SHA256 = "sha256:bdb547c3deb055941d1e67f0b24defb9a6279972b7dcabbba2fe44c7fd75c9e0"


class ActionSpec(BaseModel):
    """The transaction to execute. Accepts neither category nor notional: both are derived from the calldata, never declared."""

    model_config = ConfigDict(extra="ignore")

    version: Literal[1]
    chainId: int = Field(gt=0, le=9007199254740991, description="EVM chain ID of the executed transaction.")
    target: str = Field(pattern="^0x[0-9a-fA-F]{40}$", description="Contract being called.")
    value: str = Field(pattern="^(?:0|[1-9][0-9]*)$", description="Native value sent, in wei, as a decimal string.")
    calldata: str = Field(pattern="^0x(?:[0-9a-fA-F]{2})*$", description="Exact calldata of the transaction. It is from this — and from this alone — that the category, the notional and therefore the bond are derived.")
    registryRef: str = Field(pattern="^0x[0-9a-fA-F]{64}$", description="Hash of the classification registry version in use.")


class QuoteRiskInput(BaseModel):
    """Arguments of the `quote_risk` tool."""

    model_config = ConfigDict(extra="ignore")

    actionSpec: ActionSpec = Field(description="The transaction to execute. Accepts neither category nor notional: both are derived from the calldata, never declared.")
    beneficiary: str | None = Field(default=None, pattern="^0x[0-9a-fA-F]{40}$", description="Beneficiary of a potential slash. Does not affect the price; used to build the post-condition.")


class RequestWarrantInput(BaseModel):
    """Arguments of the `request_warrant` tool."""

    model_config = ConfigDict(extra="ignore")

    actionSpec: ActionSpec = Field(description="The transaction to execute. Accepts neither category nor notional: both are derived from the calldata, never declared.")
    beneficiary: str = Field(pattern="^0x[0-9a-fA-F]{40}$", description="Address that receives the bond if the post-condition is violated — the owner of the capital, never the agent.")


class GetWarrantInput(BaseModel):
    """Arguments of the `get_warrant` tool."""

    model_config = ConfigDict(extra="ignore")

    warrantId: str = Field(pattern="^0x[0-9a-fA-F]{64}$", description="Warrant identifier, as returned by request_warrant.")


class ListWarrantsInput(BaseModel):
    """Arguments of the `list_warrants` tool."""

    model_config = ConfigDict(extra="ignore")

    agent: str = Field(pattern="^0x[0-9a-fA-F]{40}$", description="Agentic wallet whose warrants are being listed.")
    status: Literal["open", "honored", "slashed", "reclaimed"] | None = Field(default=None, description="Keep only the warrants in this status.")
    category: Literal["erc20.transfer", "erc20.approve", "aavev3.repay", "aavev3.supply", "aavev3.withdraw", "aavev3.borrow", "unknown"] | None = Field(default=None, description="After-the-fact filter on the derived category. Cannot be declared at opening time.")
    since: int | None = Field(default=None, ge=0, le=9007199254740991, description="Lower bound on openedAt, in Unix seconds.")
    until: int | None = Field(default=None, ge=0, le=9007199254740991, description="Upper bound on openedAt, in Unix seconds.")
    limit: int | None = Field(default=None, ge=1, le=100, description="Maximum number of warrants returned (default 20).")
    cursor: str | None = Field(default=None, description="Pagination cursor returned by a previous call.")


#: The error catalogue, exactly as `errors.ts` lays it out. A `hint` is read by
#: an agent: rewriting it in Python would make the same code say two different
#: things depending on the adapter's language.
ERROR_CATALOG: dict[str, dict[str, str]] = {
    "invalid_input": {
        "hint": "Check the tool's fields against its inputSchema, then call it again.",
        "docs": "https://github.com/4n0nn43x/warrant/tools",
    },
    "invalid_action_spec": {
        "hint": "The actionSpec must carry version, chainId, target, value, calldata and registryRef. No category and no notional: both are derived from the calldata.",
        "docs": "https://github.com/4n0nn43x/warrant/action-spec",
    },
    "invalid_condition_spec": {
        "hint": "Fix the field named in `field` then open the warrant again: a post-condition is immutable once committed.",
        "docs": "https://github.com/4n0nn43x/warrant/post-conditions",
    },
    "classification_failed": {
        "hint": "The (target, selector) pair is absent from the registry. Call quote_risk first: an unknown action remains fundable, at the strictest rate.",
        "docs": "https://github.com/4n0nn43x/warrant/classification",
    },
    "payment_invalid": {
        "hint": "Rebuild the PaymentPayload from the PaymentRequired that was returned, without modifying `accepted`, and replay with _meta[\"x402/payment\"].",
        "docs": "https://github.com/4n0nn43x/warrant/payments#x402",
    },
    "warrant_not_found": {
        "hint": "Check the warrantId (bytes32, 0x + 64 hex). list_warrants({ agent }) lists the known warrants.",
        "docs": "https://github.com/4n0nn43x/warrant/warrants#lookup",
    },
    "gateway_unreachable": {
        "hint": "The Warrant Gateway is unreachable. Retry; no warrant and no payment were committed.",
        "docs": "https://github.com/4n0nn43x/warrant/troubleshooting#gateway",
    },
    "gateway_error": {
        "hint": "Retry; if it persists, the detail is in `details`.",
        "docs": "https://github.com/4n0nn43x/warrant/troubleshooting#gateway",
    },
    "invalid_base_url": {
        "hint": "The Gateway URL must be http(s). A file:, ftp: or data: URL is not a Gateway, and a client that opens one would return its bytes as though the Gateway had sent them. Check WARRANT_BASE_URL.",
        "docs": "https://github.com/4n0nn43x/warrant/troubleshooting#gateway",
    },
}


#: The four tools, in source order: quote, warrant, read, history. `input_model`
#: is the Pydantic model above; `input_schema` is the draft-7 JSON Schema
#: published as-is by `tools/list` on the MCP side.
TOOL_MANIFEST: tuple[dict[str, Any], ...] = (
    {
        "name": "quote_risk",
        "title": "Quote the bond for an action",
        "description": "Estimates the bond required for an action, committing nothing and paying nothing. Classifies the calldata, derives the notional from it, then returns the bond, the risk rate and the post-condition that will be committed. Call this before request_warrant: it is free, and it is the only way to learn the cost before committing. The category and the notional are derived from the calldata; they cannot be declared.",
        "paid": False,
        "read_only": True,
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "actionSpec": {
                    "type": "object",
                    "properties": {
                        "version": {
                            "type": "number",
                            "const": 1,
                        },
                        "chainId": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991,
                            "description": "EVM chain ID of the executed transaction.",
                        },
                        "target": {
                            "type": "string",
                            "pattern": "^0x[0-9a-fA-F]{40}$",
                            "description": "Contract being called.",
                        },
                        "value": {
                            "type": "string",
                            "pattern": "^(?:0|[1-9][0-9]*)$",
                            "description": "Native value sent, in wei, as a decimal string.",
                        },
                        "calldata": {
                            "type": "string",
                            "pattern": "^0x(?:[0-9a-fA-F]{2})*$",
                            "description": "Exact calldata of the transaction. It is from this — and from this alone — that the category, the notional and therefore the bond are derived.",
                        },
                        "registryRef": {
                            "type": "string",
                            "pattern": "^0x[0-9a-fA-F]{64}$",
                            "description": "Hash of the classification registry version in use.",
                        },
                    },
                    "required": [
                        "version",
                        "chainId",
                        "target",
                        "value",
                        "calldata",
                        "registryRef",
                    ],
                    "description": "The transaction to execute. Accepts neither category nor notional: both are derived from the calldata, never declared.",
                },
                "beneficiary": {
                    "description": "Beneficiary of a potential slash. Does not affect the price; used to build the post-condition.",
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                },
            },
            "required": [
                "actionSpec",
            ],
        },
        "output_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Category derived from the calldata.",
                },
                "bond": {
                    "type": "string",
                    "description": "Bond required, in atomic units (USDC, 6 decimals).",
                },
                "riskBps": {
                    "type": "number",
                    "description": "Risk rate applied, in basis points.",
                },
                "notionalUSD": {
                    "type": "string",
                    "description": "Notional derived from the decoded arguments.",
                },
                "conditionSpec": {
                    "type": "object",
                    "propertyNames": {
                        "type": "string",
                    },
                    "additionalProperties": {},
                    "description": "Post-condition that will be committed under conditionHash.",
                },
                "rationale": {
                    "type": "string",
                    "description": "One-sentence justification of the price.",
                },
            },
            "required": [
                "category",
                "bond",
                "riskBps",
                "notionalUSD",
                "conditionSpec",
                "rationale",
            ],
            "additionalProperties": False,
        },
        "input_model": QuoteRiskInput,
    },
    {
        "name": "request_warrant",
        "title": "Open a bonded warrant",
        "description": "Opens a bonded warrant for the given action and has KeeperHub execute it. Paid: the bond must be funded via x402 before the warrant opens. Returns the warrantId, the executionId and the conditionHash / actionHash commitments. If the post-condition holds, the bond comes back; otherwise it goes to the beneficiary. The bond is derived from the calldata — it is not negotiable.",
        "paid": True,
        "read_only": False,
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "actionSpec": {
                    "type": "object",
                    "properties": {
                        "version": {
                            "type": "number",
                            "const": 1,
                        },
                        "chainId": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991,
                            "description": "EVM chain ID of the executed transaction.",
                        },
                        "target": {
                            "type": "string",
                            "pattern": "^0x[0-9a-fA-F]{40}$",
                            "description": "Contract being called.",
                        },
                        "value": {
                            "type": "string",
                            "pattern": "^(?:0|[1-9][0-9]*)$",
                            "description": "Native value sent, in wei, as a decimal string.",
                        },
                        "calldata": {
                            "type": "string",
                            "pattern": "^0x(?:[0-9a-fA-F]{2})*$",
                            "description": "Exact calldata of the transaction. It is from this — and from this alone — that the category, the notional and therefore the bond are derived.",
                        },
                        "registryRef": {
                            "type": "string",
                            "pattern": "^0x[0-9a-fA-F]{64}$",
                            "description": "Hash of the classification registry version in use.",
                        },
                    },
                    "required": [
                        "version",
                        "chainId",
                        "target",
                        "value",
                        "calldata",
                        "registryRef",
                    ],
                    "description": "The transaction to execute. Accepts neither category nor notional: both are derived from the calldata, never declared.",
                },
                "beneficiary": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                    "description": "Address that receives the bond if the post-condition is violated — the owner of the capital, never the agent.",
                },
            },
            "required": [
                "actionSpec",
                "beneficiary",
            ],
        },
        "output_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "warrantId": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                },
                "executionId": {
                    "type": "string",
                    "description": "KeeperHub identifier of the execution.",
                },
                "conditionHash": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                    "description": "keccak256(JCS(conditionSpec)) — immutable commitment.",
                },
                "actionHash": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                    "description": "keccak256(JCS(actionSpec)) — commitment to what is being asked.",
                },
                "expiry": {
                    "type": "number",
                    "description": "Past this point, honor/slash are closed and reclaim() is open.",
                },
            },
            "required": [
                "warrantId",
                "executionId",
                "conditionHash",
                "actionHash",
                "expiry",
            ],
            "additionalProperties": False,
        },
        "input_model": RequestWarrantInput,
    },
    {
        "name": "get_warrant",
        "title": "Read a warrant and its verdict",
        "description": "Returns a warrant, its status and — once it is settled — the full verdict with the checks[] detail: one row per check, including the ones that pass, plus the exact block of evaluation. That is what makes a verdict replayable by a third party rather than taken on trust.",
        "paid": False,
        "read_only": True,
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "warrantId": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                    "description": "Warrant identifier, as returned by request_warrant.",
                },
            },
            "required": [
                "warrantId",
            ],
        },
        "output_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "warrantId": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                },
                "agent": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                },
                "beneficiary": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                },
                "bond": {
                    "type": "string",
                },
                "conditionHash": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                },
                "actionHash": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                },
                "expiry": {
                    "type": "number",
                },
                "openedAt": {
                    "type": "number",
                },
                "status": {
                    "type": "number",
                    "description": "0 None, 1 Open, 2 Honored, 3 Slashed, 4 Reclaimed.",
                },
                "verdict": {
                    "description": "Present once the warrant is settled.",
                    "type": "object",
                    "propertyNames": {
                        "type": "string",
                    },
                    "additionalProperties": {},
                },
                "checks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                            },
                            "expected": {
                                "type": "string",
                            },
                            "observed": {
                                "type": "string",
                            },
                            "pass": {
                                "type": "boolean",
                            },
                        },
                        "required": [
                            "kind",
                            "expected",
                            "observed",
                            "pass",
                        ],
                        "additionalProperties": False,
                    },
                    "description": "One row per check, including the ones that pass — a partial verdict would not be auditable.",
                },
            },
            "required": [
                "warrantId",
                "agent",
                "beneficiary",
                "bond",
                "conditionHash",
                "actionHash",
                "expiry",
                "openedAt",
                "status",
                "checks",
            ],
            "additionalProperties": False,
        },
        "input_model": GetWarrantInput,
    },
    {
        "name": "list_warrants",
        "title": "List an agent warrants and statistics",
        "description": "Lists an agent's warrants along with their aggregated statistics: number honored, number slashed, total bonded, honor rate. Filterable by status, category and time window. Use it to answer \"what is this agent's track record?\" without reading the chain.",
        "paid": False,
        "read_only": True,
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "agent": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                    "description": "Agentic wallet whose warrants are being listed.",
                },
                "status": {
                    "description": "Keep only the warrants in this status.",
                    "type": "string",
                    "enum": [
                        "open",
                        "honored",
                        "slashed",
                        "reclaimed",
                    ],
                },
                "category": {
                    "description": "After-the-fact filter on the derived category. Cannot be declared at opening time.",
                    "type": "string",
                    "enum": [
                        "erc20.transfer",
                        "erc20.approve",
                        "aavev3.repay",
                        "aavev3.supply",
                        "aavev3.withdraw",
                        "aavev3.borrow",
                        "unknown",
                    ],
                },
                "since": {
                    "description": "Lower bound on openedAt, in Unix seconds.",
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991,
                },
                "until": {
                    "description": "Upper bound on openedAt, in Unix seconds.",
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991,
                },
                "limit": {
                    "description": "Maximum number of warrants returned (default 20).",
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                },
                "cursor": {
                    "description": "Pagination cursor returned by a previous call.",
                    "type": "string",
                },
            },
            "required": [
                "agent",
            ],
        },
        "output_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "warrants": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "propertyNames": {
                            "type": "string",
                        },
                        "additionalProperties": {},
                    },
                },
                "stats": {
                    "type": "object",
                    "properties": {
                        "total": {
                            "type": "number",
                        },
                        "open": {
                            "type": "number",
                        },
                        "honored": {
                            "type": "number",
                        },
                        "slashed": {
                            "type": "number",
                        },
                        "reclaimed": {
                            "type": "number",
                        },
                        "bondHonoredTotal": {
                            "type": "string",
                        },
                        "bondSlashedTotal": {
                            "type": "string",
                        },
                        "totalAtRisk": {
                            "type": "string",
                        },
                    },
                    "required": [
                        "total",
                        "open",
                        "honored",
                        "slashed",
                        "reclaimed",
                        "bondHonoredTotal",
                        "bondSlashedTotal",
                        "totalAtRisk",
                    ],
                    "additionalProperties": False,
                },
                "nextCursor": {
                    "type": "string",
                },
            },
            "required": [
                "warrants",
                "stats",
            ],
            "additionalProperties": False,
        },
        "input_model": ListWarrantsInput,
    },
)

TOOL_NAMES: tuple[str, ...] = tuple(spec["name"] for spec in TOOL_MANIFEST)

__all__ = [
    "ERROR_CATALOG",
    "JSON_SCHEMA_DIALECT",
    "MANIFEST_SHA256",
    "MANIFEST_VERSION",
    "TOOL_MANIFEST",
    "TOOL_NAMES",
    "ActionSpec",
    "QuoteRiskInput",
    "RequestWarrantInput",
    "GetWarrantInput",
    "ListWarrantsInput",
]
