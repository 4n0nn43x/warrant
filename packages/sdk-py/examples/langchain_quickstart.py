"""Zero to a warrant with LangChain, in one file and with no configuration.

    python examples/langchain_quickstart.py

It starts the mock Gateway in-process, builds the four LangChain tools, prints what
the model would see, then drives the whole sequence through the LangChain tool
interface: quote, warrant, verdict, history. No API key, no chain, no faucet.

If ``ANTHROPIC_API_KEY`` is set **and** ``langchain`` and ``langchain-anthropic``
are installed, it also runs a real agent at the end and lets the model choose the
calls itself. That part is optional on purpose: a quickstart that cannot run
without a paid API key is not a quickstart.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mock_gateway import BENEFICIARY, USDC, serve  # noqa: E402

from warrant_sdk.langchain import warrant_tools  # noqa: E402

#: Compte 1 d'Anvil. Publique, sans valeur, et c'est le point : le mock vérifie la
#: signature, il ne déplace rien. Ne jamais réutiliser une clé de démo sur un
#: réseau où elle détient quoi que ce soit.
DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

#: `transfer(0x…dEaD, 1_000_000)` — 1 USDC, six décimales.
#: La catégorie et le notionnel sortiront de ce calldata, et de rien d'autre.
CALLDATA = (
    "0xa9059cbb"
    "000000000000000000000000000000000000000000000000000000000000dead"
    "00000000000000000000000000000000000000000000000000000000000f4240"
)

ACTION_SPEC = {
    "version": 1,
    "chainId": 84532,
    "target": USDC.lower(),
    "value": "0",
    "calldata": CALLDATA,
    "registryRef": "0x" + "00" * 31 + "01",
}


def rule(title: str) -> None:
    print(f"\n\033[1m── {title} {'─' * max(0, 66 - len(title))}\033[0m")


def show(label: str, payload: str, *, lines: int = 26) -> None:
    """Print a JSON payload, elided on a line boundary rather than mid-token."""
    print(f"\n{label}")
    rendered = payload.splitlines()
    print("\n".join(rendered[:lines]))
    if len(rendered) > lines:
        print(f"  … {len(rendered) - lines} more lines")


def main() -> int:
    server, gateway = serve(port=0, quiet=True)
    base_url = f"http://127.0.0.1:{server.server_port}"
    print(f"mock Gateway on {base_url} — no chain is touched, no money moves")

    tools = warrant_tools(base_url=base_url, private_key=DEMO_KEY)
    by_name = {tool.name: tool for tool in tools}

    rule("what the model sees")
    for tool in tools:
        schema = tool.args_schema.model_json_schema()
        print(f"\n  \033[1m{tool.name}\033[0m({', '.join(schema.get('properties', {}))})")
        print(f"    {tool.description[:150]}…")
    print(
        "\n  None of the four accepts a `category` or a `notional` field: both are"
        "\n  derived from the calldata. Slipping one in gets it dropped, not rejected."
    )

    rule("1. quote_risk — free, commits nothing")
    show(
        "  the bond this action would cost:",
        by_name["quote_risk"].invoke({"actionSpec": ACTION_SPEC}),
    )

    rule("1b. the rule, demonstrated rather than asserted")
    print(
        "  Same call, with `category` and `notional` smuggled into the actionSpec.\n"
        "  Watch the price not move — and watch what the Gateway receives, below."
    )
    poisoned = by_name["quote_risk"].invoke(
        {
            "actionSpec": {**ACTION_SPEC, "category": "aavev3.repay", "notional": "1"},
            "beneficiary": BENEFICIARY,
        }
    )
    honest_bond = json.loads(by_name["quote_risk"].invoke({"actionSpec": ACTION_SPEC}))["bond"]
    poisoned_body = json.loads(poisoned)
    print(
        f"\n  bond without the extra fields: {honest_bond}\n"
        f"  bond with them:                {poisoned_body['bond']}\n"
        f"  category derived from calldata: {poisoned_body['category']} "
        f"(not the aavev3.repay that was declared)"
    )

    rule("2. request_warrant — paid, over x402")
    print(
        "  The bond is funded by an EIP-3009 ReceiveWithAuthorization signature\n"
        "  whose nonce equals termsHash(warrantId, beneficiary, bond, conditionHash,\n"
        "  actionHash, duration). Signing the payment is signing the terms.\n"
        "  The Gateway here recovers the signer and recomputes that hash — a\n"
        "  TransferWithAuthorization signature would be refused by name."
    )
    opened = by_name["request_warrant"].invoke(
        {"actionSpec": ACTION_SPEC, "beneficiary": BENEFICIARY}
    )
    show("  opened:", opened)
    warrant_id = json.loads(opened).get("warrantId")
    if warrant_id is None:
        print("\n  no warrant opened — the payload above says why")
        server.shutdown()
        return 1

    rule("3. get_warrant — the verdict, with every check")
    show("  ", by_name["get_warrant"].invoke({"warrantId": warrant_id}))
    print(
        "\n  Every check is listed, including the ones that passed. A verdict that\n"
        "  showed only the failing check would not be auditable."
    )

    rule("4. list_warrants — the agent's record")
    agent = json.loads(opened)["agent"] if "agent" in json.loads(opened) else None
    agent = agent or next(iter(gateway.warrants.values()))["agent"]
    show("  ", by_name["list_warrants"].invoke({"agent": agent}))

    rule("what the Gateway actually received")
    for seen in gateway.seen:
        keys = sorted((seen["body"].get("actionSpec") or {}).keys())
        print(f"  {seen['path']:<16} actionSpec keys: {keys}")
    print("  No `category`, no `notional` — the SDK scrubbed them before the request.")

    _optional_agent(base_url)
    server.shutdown()
    print("\ndone.")
    return 0


def _optional_agent(base_url: str) -> None:
    """Run a real agent, if and only if the environment can afford one."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "\n(set ANTHROPIC_API_KEY and `pip install langchain langchain-anthropic`"
            "\n to let a model drive the same four tools itself)"
        )
        return
    try:
        from langchain.agents import create_agent
    except ModuleNotFoundError:
        print("\n(ANTHROPIC_API_KEY is set but `langchain` is not installed — skipping)")
        return

    rule("5. a model choosing the calls itself")
    agent = create_agent(
        model="anthropic:claude-opus-4-5",
        tools=warrant_tools(base_url=base_url, private_key=DEMO_KEY),
        system_prompt=(
            "You bond onchain actions before they execute. Always call quote_risk "
            "first. Never claim an action is safe — say which post-condition it is "
            "bonded against, and what the bond costs."
        ),
    )
    result = agent.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "How much would it cost to bond this action, and what gets "
                        f"committed? actionSpec = {json.dumps(ACTION_SPEC)}"
                    ),
                }
            ]
        }
    )
    print(f"\n  {result['messages'][-1].content}")


if __name__ == "__main__":
    raise SystemExit(main())
