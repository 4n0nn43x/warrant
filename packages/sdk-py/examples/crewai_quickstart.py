"""Zero to a warrant with CrewAI, in one file and with no configuration.

    python examples/crewai_quickstart.py

Starts the mock Gateway in-process, builds the four CrewAI tools, and drives the
full sequence through the CrewAI tool interface: quote, warrant, verdict, history.
No API key, no chain, no faucet.

If ``ANTHROPIC_API_KEY`` is set it also runs a one-agent crew at the end and lets
the model choose the calls. A ``Crew.kickoff()`` always calls an LLM, so that part
cannot be the default — a quickstart that needs a paid key is not a quickstart.

The tools are the *same* tools as in ``langchain_quickstart.py``: same names, same
descriptions, same argument schemas, same payment loop. Only the wrapper class
differs. That is the point of a single source of truth — see ``_adapter.py``, which
both adapters share.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mock_gateway import BENEFICIARY, USDC, serve  # noqa: E402

from warrant_sdk.crewai import warrant_tools  # noqa: E402

#: Compte 1 d'Anvil. Publique, sans valeur : le mock vérifie la signature, il ne
#: déplace rien. Ne jamais réutiliser une clé de démo là où elle détient quelque chose.
DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

ACTION_SPEC = {
    "version": 1,
    "chainId": 84532,
    "target": USDC.lower(),
    "value": "0",
    # transfer(0x…dEaD, 1_000_000) — 1 USDC. Catégorie et notionnel en sortiront.
    "calldata": (
        "0xa9059cbb"
        "000000000000000000000000000000000000000000000000000000000000dead"
        "00000000000000000000000000000000000000000000000000000000000f4240"
    ),
    "registryRef": "0x" + "00" * 31 + "01",
}


def rule(title: str) -> None:
    print(f"\n\033[1m── {title} {'─' * max(0, 66 - len(title))}\033[0m")


def brief(payload: str, *keys: str) -> str:
    """Show only the fields that carry the point being made."""
    body = json.loads(payload)
    if not isinstance(body, dict):
        return payload
    return json.dumps({k: body[k] for k in keys if k in body}, ensure_ascii=False, indent=2)


def main() -> int:
    server, gateway = serve(port=0, quiet=True)
    base_url = f"http://127.0.0.1:{server.server_port}"
    print(f"mock Gateway on {base_url} — no chain is touched, no money moves")

    tools = warrant_tools(base_url=base_url, private_key=DEMO_KEY)
    by_name = {tool.name: tool for tool in tools}

    rule("the crew's toolbelt")
    for tool in tools:
        paid = "paid" if tool.name == "request_warrant" else "free"
        print(f"  {type(tool).__name__:<20} {tool.name:<16} {paid:<5} args: {tool.args_schema.__name__}")

    rule("1. quote_risk — free")
    quote = by_name["quote_risk"].run(actionSpec=ACTION_SPEC)
    print(brief(quote, "category", "bond", "riskBps", "notionalUSD", "rationale"))

    rule("2. request_warrant — paid, x402 + EIP-3009 ReceiveWithAuthorization")
    opened = by_name["request_warrant"].run(actionSpec=ACTION_SPEC, beneficiary=BENEFICIARY)
    body = json.loads(opened)
    if "warrantId" not in body:
        print(opened)
        server.shutdown()
        return 1
    print(brief(opened, "warrantId", "bond", "conditionHash", "actionHash", "fundingRef"))
    print(
        "\n  `fundingRef` is the EIP-3009 nonce, and that nonce IS the termsHash of\n"
        "  the six committed terms. Signing the payment signed the terms."
    )

    rule("3. get_warrant — the verdict")
    view = json.loads(by_name["get_warrant"].run(warrantId=body["warrantId"]))
    print(f"  status {view['status']} (2 = honored), {len(view['checks'])} checks:")
    for check in view["checks"]:
        mark = "✓" if check["pass"] else "✗"
        print(f"    {mark} {check['kind']}")

    rule("4. list_warrants — the record")
    stats = json.loads(by_name["list_warrants"].run(agent=view["agent"]))["stats"]
    print(json.dumps(stats, indent=2))

    _optional_crew(base_url)
    server.shutdown()
    print("\ndone.")
    return 0


def _optional_crew(base_url: str) -> None:
    """Run a real crew, if and only if the environment can afford one."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("\n(set ANTHROPIC_API_KEY to let a one-agent crew drive the same four tools)")
        return
    from crewai import Agent, Crew, Task

    rule("5. a crew choosing the calls itself")
    treasurer = Agent(
        role="Treasury operator",
        goal="Never move funds without a bonded mandate, and never overpay for one",
        backstory=(
            "Prices every action before executing it. Refuses to negotiate a bond: "
            "it is derived from the calldata, so there is nothing to negotiate."
        ),
        tools=warrant_tools(base_url=base_url, private_key=DEMO_KEY),
        llm="anthropic/claude-opus-4-5",
        verbose=True,
    )
    task = Task(
        description=(
            "Price the bond for this action and report what post-condition would be "
            f"committed. Do not open a warrant. actionSpec = {json.dumps(ACTION_SPEC)}"
        ),
        expected_output="The bond in USDC, the derived category, and the committed checks.",
        agent=treasurer,
    )
    print(Crew(agents=[treasurer], tasks=[task], verbose=True).kickoff())


if __name__ == "__main__":
    raise SystemExit(main())
