"""Le pont partagé entre LangChain et CrewAI.

Les deux frameworks veulent la même chose — un nom, une description, un modèle
Pydantic d'arguments, une fonction — et diffèrent seulement sur la classe qui les
emballe. Tout ce qui est commun est donc ici, une seule fois : les deux
adaptateurs qui suivent font moins de cinquante lignes chacun, et il n'existe
aucun endroit où l'un pourrait se comporter autrement que l'autre.

Contrainte de conception héritée de `ai.ts` : un adaptateur ne contient **aucune**
logique métier. S'il grossit, c'est que quelque chose appartient à `tools.py`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from .client import WarrantClient
from .errors import WarrantError
from .gateway import GatewayClient
from .tools import WARRANT_TOOLS, WarrantTool, run_tool
from .x402 import PaymentSigner

__all__ = ["ToolBridge", "bridges", "resolve_client"]


def resolve_client(
    *,
    client: GatewayClient | None = None,
    base_url: str | None = None,
    private_key: str | None = None,
    signer: PaymentSigner | None = None,
) -> GatewayClient:
    """Build a Gateway client, or pass through the one given.

    Accepting a ready-made ``client`` is what makes the adapters testable without a
    network: any object satisfying :class:`~warrant_sdk.gateway.GatewayClient` will
    do, including an in-memory double.
    """
    if client is not None:
        return client
    kwargs: dict[str, Any] = {}
    if base_url is not None:
        kwargs["base_url"] = base_url
    if private_key is not None:
        kwargs["private_key"] = private_key
    if signer is not None:
        kwargs["signer"] = signer
    return WarrantClient(**kwargs)


@dataclass(frozen=True)
class ToolBridge:
    """One tool, ready to be wrapped by any framework.

    Attributes:
        tool: The descriptor, from the generated manifest.
        client: Where the call goes.
        signer: Optional bond signer. Without it, ``request_warrant`` returns the
            payment requirement instead of settling it.
    """

    tool: WarrantTool
    client: GatewayClient
    signer: PaymentSigner | None = None

    @property
    def name(self) -> str:
        return self.tool.name

    @property
    def description(self) -> str:
        return self.tool.description

    @property
    def args_schema(self) -> type:
        return self.tool.input_model

    def invoke(self, **kwargs: Any) -> str:
        """Run the tool and render the result as JSON text.

        Returns a **string**, and never raises for a Warrant-level failure. Both
        choices are about what a model can do with the answer:

        * JSON text is what ends up in the conversation either way — letting the
          framework coerce a dict with ``str()`` would produce Python repr, with
          single quotes and ``True``, which models reproduce badly when asked to
          echo an id back.
        * A raised exception is, for most agent runtimes, the end of the run. A
          returned error carrying ``hint`` and ``field`` is a turn the model can
          use to correct itself — which is the entire point of making errors
          actionable.

        Transport failures are the exception to the exception: they are not
        something a model can fix by rewording its arguments, and they leave
        nothing committed, so they propagate.
        """
        try:
            outcome = run_tool(self.client, self.tool, kwargs, signer=self._signer())
        except WarrantError as err:
            if err.code == "gateway_unreachable":
                raise
            return _json(err.to_json())

        if outcome.kind == "ok":
            data = outcome.data
            if outcome.settlement is not None and isinstance(data, dict):
                data = {**data, "settlement": outcome.settlement}
            return _json(data)

        # Rendu, pas levé : le modèle doit pouvoir lire l'exigence de paiement et
        # décider. C'est le pendant du choix de rendre quote_risk gratuit.
        return _json(
            {
                "paymentRequired": outcome.payment_required,
                "hint": (
                    "The bond is not funded. Pass a key to warrant_tools(private_key=...) "
                    "or set WARRANT_PRIVATE_KEY, then call request_warrant again. The "
                    "amount to fund is accepts[0].amount, in atomic units of accepts[0].asset."
                ),
            }
        )

    def _signer(self) -> PaymentSigner | None:
        return self.signer if self.signer is not None else getattr(self.client, "signer", None)

    def callable(self) -> Callable[..., str]:
        """A plain function, for frameworks that want one rather than a method."""

        def _call(**kwargs: Any) -> str:
            return self.invoke(**kwargs)

        _call.__name__ = self.tool.name
        _call.__doc__ = self.tool.description
        return _call


def bridges(
    client: GatewayClient,
    *,
    signer: PaymentSigner | None = None,
    only: Iterable[str] | None = None,
) -> list[ToolBridge]:
    """Bridge every tool, or the subset named in ``only``.

    ``only=["quote_risk"]`` is the read-only, spend-nothing configuration: worth
    having as one argument, because "let the agent price actions but never open a
    warrant" is a real deployment and not an exotic one.
    """
    selected = WARRANT_TOOLS if only is None else [t for t in WARRANT_TOOLS if t.name in set(only)]
    if only is not None and len(selected) != len(set(only)):
        unknown = sorted(set(only) - {t.name for t in WARRANT_TOOLS})
        raise WarrantError(
            "invalid_input",
            f"Unknown tool name(s) in `only`: {', '.join(unknown)}.",
            hint=f"The available tools are {', '.join(t.name for t in WARRANT_TOOLS)}.",
        )
    return [ToolBridge(tool=tool, client=client, signer=signer) for tool in selected]


def _json(value: Any) -> str:
    # `ensure_ascii=False` : les descriptions et les verdicts portent des accents,
    # et une séquence \uXXXX dans un prompt est du bruit que le modèle recopie mal.
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)
