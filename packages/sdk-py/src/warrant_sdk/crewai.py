"""CrewAI adapter.

```python
from crewai import Agent, Crew, Task
from warrant_sdk.crewai import warrant_tools

treasurer = Agent(
    role="Treasury operator",
    goal="Move funds only under a bonded mandate",
    backstory="Bonds every action before executing it.",
    tools=warrant_tools(base_url="http://127.0.0.1:8402"),
)
```

Shares everything with the LangChain adapter except the wrapper class — see
``_adapter.py``. The only CrewAI-specific part is that ``BaseTool`` is a Pydantic
model whose ``name``, ``description`` and ``args_schema`` are fields, so each tool
becomes a subclass built at import time rather than an instance configured at
construction time.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Iterable

from ._adapter import ToolBridge, bridges, resolve_client
from .gateway import GatewayClient
from .x402 import PaymentSigner

if TYPE_CHECKING:  # pragma: no cover
    from crewai.tools import BaseTool

__all__ = ["warrant_tools"]


def warrant_tools(
    *,
    client: GatewayClient | None = None,
    base_url: str | None = None,
    private_key: str | None = None,
    signer: PaymentSigner | None = None,
    only: Iterable[str] | None = None,
) -> list["BaseTool"]:
    """Project the four Warrant tools into CrewAI tools.

    Arguments are identical to :func:`warrant_sdk.langchain.warrant_tools`, which
    is the point: switching framework should not change how Warrant is configured.

    Raises:
        ImportError: If ``crewai`` is not installed.
    """
    try:
        from crewai.tools import BaseTool
    except ModuleNotFoundError as err:  # pragma: no cover — chemin d'installation
        raise ImportError(
            "warrant_sdk.crewai needs crewai. Install it with "
            "`pip install 'warrant-sdk[crewai]'`."
        ) from err

    resolved = resolve_client(
        client=client, base_url=base_url, private_key=private_key, signer=signer
    )
    return [_wrap(BaseTool, bridge) for bridge in bridges(resolved, signer=signer, only=only)]


def _wrap(base: type, bridge: ToolBridge) -> Any:
    """Build and instantiate the ``BaseTool`` subclass for one bridge.

    ``name``, ``description`` and ``args_schema`` go through the **constructor**,
    not the class body. Overriding an inherited Pydantic field with a plain class
    attribute is an error in Pydantic v2 (``PydanticUserError``: the override needs
    an annotation), and re-annotating fields we do not own would couple this
    adapter to CrewAI's internal types. The bridge is captured in the closure for
    the same kind of reason: a ``ToolBridge`` holding a live HTTP client has no
    business being handed to a validator.
    """

    def _run(self: Any, **kwargs: Any) -> str:
        return bridge.invoke(**kwargs)

    class_name = "".join(part.capitalize() for part in bridge.name.split("_")) + "Tool"
    subclass = type(class_name, (base,), {"_run": _run, "__doc__": bridge.description})
    return subclass(
        name=bridge.name,
        description=bridge.description,
        args_schema=bridge.args_schema,
    )
