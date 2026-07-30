"""LangChain adapter.

```python
from langchain.agents import create_agent
from warrant_sdk.langchain import warrant_tools

agent = create_agent(
    model="anthropic:claude-opus-4-5",
    tools=warrant_tools(base_url="http://127.0.0.1:8402"),
)
agent.invoke({"messages": [{"role": "user", "content": "Bond a 1 USDC transfer to 0x…dEaD"}]})
```

Nothing is declared here: names, descriptions and argument schemas come from the
single source of truth via the generated manifest. The adapter's whole job is to
put a ``StructuredTool`` around each of them.

``langchain-core`` is imported lazily. A user who installed ``warrant-sdk`` for the
CLI or for CrewAI should not pay for a LangChain import, and a missing dependency
should say what to install rather than raise ``ModuleNotFoundError`` from three
frames deep.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Iterable

from ._adapter import bridges, resolve_client
from .gateway import GatewayClient
from .x402 import PaymentSigner

if TYPE_CHECKING:  # pragma: no cover
    from langchain_core.tools import StructuredTool

__all__ = ["warrant_tools"]


def warrant_tools(
    *,
    client: GatewayClient | None = None,
    base_url: str | None = None,
    private_key: str | None = None,
    signer: PaymentSigner | None = None,
    only: Iterable[str] | None = None,
) -> list["StructuredTool"]:
    """Project the four Warrant tools into LangChain tools.

    Args:
        client: A ready-made Gateway client. Anything satisfying
            :class:`~warrant_sdk.gateway.GatewayClient`, including a test double.
        base_url: Gateway root. Defaults to ``$WARRANT_BASE_URL``, then to
            ``http://127.0.0.1:8402``.
        private_key: Agent key that signs the EIP-3009 bond authorization.
            Defaults to ``$WARRANT_PRIVATE_KEY``. Without it, ``request_warrant``
            returns the payment requirement instead of paying it — which is the
            safe default, not a degraded mode.
        signer: A custom :class:`~warrant_sdk.x402.PaymentSigner`, for a KMS or a
            remote signer. Takes precedence over ``private_key``.
        only: Restrict the set exposed to the model, e.g. ``["quote_risk"]`` for a
            read-only agent.

    Returns:
        One ``StructuredTool`` per tool, in the order of the source: quote,
        warrant, read, history.

    Raises:
        ImportError: If ``langchain-core`` is not installed.
    """
    try:
        from langchain_core.tools import StructuredTool
    except ModuleNotFoundError as err:  # pragma: no cover — chemin d'installation
        raise ImportError(
            "warrant_sdk.langchain needs langchain-core. Install it with "
            "`pip install 'warrant-sdk[langchain]'`."
        ) from err

    resolved = resolve_client(
        client=client, base_url=base_url, private_key=private_key, signer=signer
    )

    tools: list[Any] = []
    for bridge in bridges(resolved, signer=signer, only=only):
        tools.append(
            StructuredTool.from_function(
                func=bridge.callable(),
                name=bridge.name,
                description=bridge.description,
                args_schema=bridge.args_schema,
                # Le modèle reçoit le JSON rendu par le pont, y compris pour une
                # erreur : c'est ce qui lui permet de se corriger au tour suivant
                # plutôt que d'interrompre la boucle de l'agent.
                handle_tool_error=False,
                return_direct=False,
            )
        )
    return tools
