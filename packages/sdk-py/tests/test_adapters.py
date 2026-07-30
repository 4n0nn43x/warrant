"""Les deux adaptateurs de framework, et ce qu'ils doivent avoir en commun.

Le test qui compte est le dernier : LangChain et CrewAI doivent exposer **le même**
nom, la même description et le même schéma d'arguments. Une divergence entre les
deux serait exactement ce que la source unique existe pour empêcher, et elle
passerait inaperçue autrement — chaque adaptateur, pris seul, aurait l'air correct.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from warrant_sdk import WARRANT_TOOLS, WarrantError

langchain_module = pytest.importorskip("langchain_core.tools", reason="langchain-core absent")
crewai_module = pytest.importorskip("crewai.tools", reason="crewai absent")

from warrant_sdk.crewai import warrant_tools as crewai_tools  # noqa: E402
from warrant_sdk.langchain import warrant_tools as langchain_tools  # noqa: E402


@pytest.fixture
def lc_tools(gateway: tuple[str, Any]) -> list[Any]:
    from conftest import DEMO_KEY

    return langchain_tools(base_url=gateway[0], private_key=DEMO_KEY)


@pytest.fixture
def crew_tools(gateway: tuple[str, Any]) -> list[Any]:
    from conftest import DEMO_KEY

    return crewai_tools(base_url=gateway[0], private_key=DEMO_KEY)


def test_langchain_exposes_the_four_tools(lc_tools: list[Any]) -> None:
    assert [tool.name for tool in lc_tools] == [t.name for t in WARRANT_TOOLS]


def test_crewai_exposes_the_four_tools(crew_tools: list[Any]) -> None:
    assert [tool.name for tool in crew_tools] == [t.name for t in WARRANT_TOOLS]


def test_the_two_adapters_agree_on_everything_the_model_sees(
    lc_tools: list[Any], crew_tools: list[Any]
) -> None:
    """Same names, same descriptions, same argument schemas.

    If this ever fails, one adapter has grown logic of its own — which is the
    failure mode a single source of truth exists to prevent.
    """
    for lc, crew in zip(lc_tools, crew_tools, strict=True):
        assert lc.name == crew.name
        assert lc.description == crew.description
        assert lc.args_schema.model_json_schema() == crew.args_schema.model_json_schema()


def test_the_json_schema_carries_the_field_descriptions(lc_tools: list[Any]) -> None:
    """What the model reads must include *why* each field exists.

    A schema with types and no descriptions makes a model guess, and it guesses that
    ``beneficiary`` is itself.
    """
    schema = {tool.name: tool.args_schema.model_json_schema() for tool in lc_tools}
    action_spec = schema["request_warrant"]["$defs"]["ActionSpec"]["properties"]
    assert "dérivés" in action_spec["calldata"]["description"]
    assert schema["request_warrant"]["properties"]["beneficiary"]["description"]
    assert "jamais l'agent" in schema["request_warrant"]["properties"]["beneficiary"]["description"]


def test_no_adapter_exposes_a_category_argument(
    lc_tools: list[Any], crew_tools: list[Any]
) -> None:
    for tool in [*lc_tools, *crew_tools]:
        if tool.name == "list_warrants":
            continue  # filtre a posteriori, pas une déclaration
        schema = tool.args_schema.model_json_schema()
        assert "category" not in schema.get("properties", {})


def test_a_langchain_call_returns_json_text(lc_tools: list[Any], action_spec: dict[str, Any]) -> None:
    """JSON text, not a Python repr.

    Frameworks coerce a returned dict with ``str()``, which yields single quotes and
    ``True`` — a shape models reproduce badly when asked to echo an id back.
    """
    by_name = {tool.name: tool for tool in lc_tools}
    raw = by_name["quote_risk"].invoke({"actionSpec": action_spec})
    assert isinstance(raw, str)
    body = json.loads(raw)
    assert body["category"] == "erc20.transfer"


def test_the_full_sequence_runs_through_both_adapters(
    lc_tools: list[Any], crew_tools: list[Any], action_spec: dict[str, Any], beneficiary: str
) -> None:
    """quote → warrant → verdict, once per framework, against the same Gateway."""
    lc = {tool.name: tool for tool in lc_tools}
    opened = json.loads(
        lc["request_warrant"].invoke({"actionSpec": action_spec, "beneficiary": beneficiary})
    )
    assert opened["warrantId"].startswith("0x")
    view = json.loads(lc["get_warrant"].invoke({"warrantId": opened["warrantId"]}))
    assert view["status"] == 2
    assert all(check["pass"] for check in view["checks"])

    crew = {tool.name: tool for tool in crew_tools}
    opened2 = json.loads(
        crew["request_warrant"].run(actionSpec=action_spec, beneficiary=beneficiary)
    )
    assert opened2["warrantId"] != opened["warrantId"], "each 402 issues a fresh warrant nonce"


def test_a_payment_requirement_reaches_the_model_rather_than_raising(
    gateway: tuple[str, Any], action_spec: dict[str, Any], beneficiary: str
) -> None:
    """The 402 must be readable by the model, with the amount and a hint.

    Raised, it would end the agent's run. Returned, it is a turn the model can use:
    report the cost to the user, or fund it.
    """
    tools = langchain_tools(base_url=gateway[0], private_key="")
    by_name = {tool.name: tool for tool in tools}
    body = json.loads(
        by_name["request_warrant"].invoke({"actionSpec": action_spec, "beneficiary": beneficiary})
    )
    assert body["paymentRequired"]["x402Version"] == 2
    assert int(body["paymentRequired"]["accepts"][0]["amount"]) > 0
    assert "WARRANT_PRIVATE_KEY" in body["hint"]


def test_a_domain_error_reaches_the_model_rather_than_raising(
    lc_tools: list[Any],
) -> None:
    """An actionable error is a turn the model can use to correct itself."""
    by_name = {tool.name: tool for tool in lc_tools}
    body = json.loads(by_name["get_warrant"].invoke({"warrantId": "0x" + "ff" * 32}))
    assert body["error"]["code"] == "warrant_not_found"
    assert body["error"]["hint"]
    assert body["error"]["docs"].startswith("https://")


def test_a_transport_failure_propagates(action_spec: dict[str, Any]) -> None:
    """Not something a model can fix by rewording, and nothing was committed."""
    tools = langchain_tools(base_url="http://127.0.0.1:1", private_key="")
    by_name = {tool.name: tool for tool in tools}
    with pytest.raises(WarrantError) as raised:
        by_name["quote_risk"].invoke({"actionSpec": action_spec})
    assert raised.value.code == "gateway_unreachable"


def test_only_restricts_the_exposed_set(gateway: tuple[str, Any]) -> None:
    """The read-only, spend-nothing deployment, in one argument."""
    tools = langchain_tools(base_url=gateway[0], only=["quote_risk"])
    assert [tool.name for tool in tools] == ["quote_risk"]


def test_an_unknown_name_in_only_is_refused(gateway: tuple[str, Any]) -> None:
    with pytest.raises(WarrantError) as raised:
        langchain_tools(base_url=gateway[0], only=["quote_risk", "quote_riskk"])
    assert "quote_riskk" in raised.value.message
