"""The tools: faithful projection, validation, input stripping."""

from __future__ import annotations

from typing import Any

import pytest

from warrant_sdk import (
    MANIFEST_SHA256,
    TOOL_MANIFEST,
    WARRANT_TOOL_NAMES,
    WARRANT_TOOLS,
    WarrantError,
    warrant_tool_by_name,
)


def test_four_tools_in_the_order_of_the_source() -> None:
    """Four, not five: ``execute_metered`` went with the routine regime."""
    assert WARRANT_TOOL_NAMES == ("quote_risk", "request_warrant", "get_warrant", "list_warrants")


def test_only_request_warrant_is_paid() -> None:
    paid = {tool.name for tool in WARRANT_TOOLS if tool.paid}
    assert paid == {"request_warrant"}
    read_only = {tool.name for tool in WARRANT_TOOLS if tool.read_only}
    assert read_only == {"quote_risk", "get_warrant", "list_warrants"}


def test_descriptions_are_the_generated_ones_verbatim(manifest: dict[str, Any]) -> None:
    """No adapter may reword a description.

    Compared against the frozen manifest rather than against itself: this catches a
    hand-edit of ``_generated.py`` that the drift test would also catch, but here
    with a message that names the tool.
    """
    frozen = {entry["name"]: entry for entry in manifest["tools"]}
    for tool in WARRANT_TOOLS:
        assert tool.description == frozen[tool.name]["description"]
        assert tool.title == frozen[tool.name]["title"]
        assert tool.input_schema == frozen[tool.name]["inputSchema"]


def test_manifest_digest_is_published() -> None:
    """An artefact built from an old manifest must be identifiable."""
    assert MANIFEST_SHA256.startswith("sha256:")
    assert len(MANIFEST_SHA256) == len("sha256:") + 64
    assert len(TOOL_MANIFEST) == 4


# ─────────────────────────────────────────────────────────────────────────────
# The rule: derived, never declared
# ─────────────────────────────────────────────────────────────────────────────


def test_category_and_notional_are_dropped_not_rejected(action_spec: dict[str, Any]) -> None:
    """The guarantee that holds against a hostile client.

    Dropped rather than rejected on purpose: rejecting would teach an agent that the
    field exists somewhere, and it exists nowhere. What matters is that the value
    handed to the Gateway is the scrubbed object, so the ``actionHash`` cannot depend
    on a stray field.
    """
    tool = warrant_tool_by_name("quote_risk")
    assert tool is not None
    parsed = tool.parse_args(
        {
            "actionSpec": {**action_spec, "category": "aavev3.repay", "notionalUSD": "999999"},
            "beneficiary": "0x" + "11" * 20,
            "notional": "999999",
        }
    )
    assert set(parsed["actionSpec"]) == set(action_spec)
    assert "notional" not in parsed
    assert parsed["actionSpec"] == action_spec


def test_scrubbing_reaches_the_gateway(client: Any, gateway: Any, action_spec: dict[str, Any]) -> None:
    """End to end: what the Gateway receives carries no declared category."""
    _, state = gateway
    client.quote_risk({"actionSpec": {**action_spec, "category": "aavev3.borrow"}})
    received = state.seen[-1]["body"]["actionSpec"]
    assert "category" not in received
    assert received == action_spec


def test_a_declared_category_does_not_move_the_price(client: Any, action_spec: dict[str, Any]) -> None:
    """Two requests differing only by declared fields must be priced identically."""
    honest = client.quote_risk({"actionSpec": action_spec})
    poisoned = client.quote_risk(
        {"actionSpec": {**action_spec, "category": "aavev3.borrow", "notionalUSD": "10000000"}}
    )
    assert honest == poisoned
    assert honest["category"] == "erc20.transfer"


# ─────────────────────────────────────────────────────────────────────────────
# Erreurs actionnables
# ─────────────────────────────────────────────────────────────────────────────


def test_a_malformed_action_field_names_itself(action_spec: dict[str, Any]) -> None:
    tool = warrant_tool_by_name("request_warrant")
    assert tool is not None
    with pytest.raises(WarrantError) as raised:
        tool.parse_args({"actionSpec": {**action_spec, "target": "not-an-address"}, "beneficiary": "0x" + "11" * 20})

    err = raised.value
    assert err.field == "$.actionSpec.target"
    assert err.code == "invalid_action_spec"
    # This code's hint is the one reminding the caller that category and notional
    # are derived: that is exactly where an agent needs it.
    assert "derived from the calldata" in err.hint
    assert err.docs.startswith("https://warrant.sh/docs")


def test_a_missing_required_argument_is_invalid_input() -> None:
    tool = warrant_tool_by_name("get_warrant")
    assert tool is not None
    with pytest.raises(WarrantError) as raised:
        tool.parse_args({})
    assert raised.value.code == "invalid_input"
    assert raised.value.field == "$.warrantId"


def test_every_error_carries_a_hint_and_a_doc_link() -> None:
    """The DX checklist rule, checked rather than trusted."""
    from warrant_sdk.errors import ERROR_CODES

    for code in ERROR_CODES:
        err = WarrantError(code, "test")
        assert err.hint, f"{code} has no hint"
        assert err.docs.startswith("https://"), f"{code} has no doc link"
        assert err.to_json()["error"]["code"] == code


def test_an_unknown_tool_lists_the_real_ones(client: Any) -> None:
    """An agent that called a wrong name must be able to correct itself."""
    with pytest.raises(WarrantError) as raised:
        client.call("execute_metered", {})
    assert "quote_risk" in raised.value.hint
    assert "list_warrants" in raised.value.hint


def test_a_missing_warrant_is_named_as_such(client: Any) -> None:
    with pytest.raises(WarrantError) as raised:
        client.read_warrant({"warrantId": "0x" + "ff" * 32})
    assert raised.value.code == "warrant_not_found"


def test_an_unreachable_gateway_says_nothing_was_committed() -> None:
    from warrant_sdk import WarrantClient

    # Port 1: immediate connection refusal, no waiting.
    client = WarrantClient(base_url="http://127.0.0.1:1", private_key="")
    with pytest.raises(WarrantError) as raised:
        client.quote_risk({"actionSpec": {"version": 1, "chainId": 1, "target": "0x" + "11" * 20, "value": "0", "calldata": "0x", "registryRef": "0x" + "00" * 32}})
    assert raised.value.code == "gateway_unreachable"
    assert "no warrant and no payment" in raised.value.hint
