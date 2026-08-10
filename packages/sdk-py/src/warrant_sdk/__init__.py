"""``warrant-sdk`` — Warrant for Python agents.

The four Warrant tools — ``quote_risk``, ``request_warrant``, ``get_warrant``,
``list_warrants`` — with adapters for LangChain and CrewAI, an x402 payment client,
and a CLI.

Nothing in this package declares a tool. Names, titles, descriptions and argument
schemas are **generated** from ``packages/sdk-ts/src/tools.ts``, the single source
of truth shared with the MCP server and the Vercel AI SDK adapter. ``_generated.py``
is the output; ``tests/test_codegen_drift.py`` fails if it ever falls behind.

Two product rules survive into every surface, because they are in the schemas
rather than in the documentation:

* an action's **category and notional are derived from its calldata, never
  declared** — no tool accepts a ``category`` or a ``notional`` field, and one
  slipped in anyway is dropped before the request is hashed;
* ``request_warrant`` without payment returns a structured x402 ``PaymentRequired``
  the agent can read and act on, rather than an opaque failure.

Quick start:

```python
from warrant_sdk import WarrantClient

client = WarrantClient(base_url="http://127.0.0.1:8402")
quote = client.quote_risk({"actionSpec": {...}})
print(quote["bond"], quote["category"])
```

For agents, see :mod:`warrant_sdk.langchain` and :mod:`warrant_sdk.crewai`.
"""

from __future__ import annotations

from ._generated import MANIFEST_SHA256, MANIFEST_VERSION, TOOL_MANIFEST
from .client import DEFAULT_BASE_URL, WarrantClient
from .errors import WarrantError, WarrantPaymentRequired
from .gateway import GatewayClient, RequestWarrantResult
from .tools import (
    WARRANT_TOOL_NAMES,
    WARRANT_TOOLS,
    ToolOutcome,
    WarrantTool,
    run_tool,
    run_tool_by_name,
    warrant_tool_by_name,
)
from .x402 import (
    RECEIVE_AUTHORIZATION_TRANSFER_METHOD,
    RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE,
    RECEIVE_WITH_AUTHORIZATION_TYPES,
    X402_VERSION,
    Eip3009Signer,
    PaymentSigner,
    commitment_terms,
    terms_hash_of,
    warrant_id_of,
)

__version__ = "0.1.2"

__all__ = [
    "DEFAULT_BASE_URL",
    "Eip3009Signer",
    "GatewayClient",
    "MANIFEST_SHA256",
    "MANIFEST_VERSION",
    "PaymentSigner",
    "RECEIVE_AUTHORIZATION_TRANSFER_METHOD",
    "RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE",
    "RECEIVE_WITH_AUTHORIZATION_TYPES",
    "RequestWarrantResult",
    "TOOL_MANIFEST",
    "ToolOutcome",
    "WARRANT_TOOLS",
    "WARRANT_TOOL_NAMES",
    "WarrantClient",
    "WarrantError",
    "WarrantPaymentRequired",
    "WarrantTool",
    "X402_VERSION",
    "__version__",
    "commitment_terms",
    "run_tool",
    "run_tool_by_name",
    "terms_hash_of",
    "warrant_id_of",
    "warrant_tool_by_name",
]
