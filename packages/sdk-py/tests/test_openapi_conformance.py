"""Cross-check between two sibling projections.

The Gateway's OpenAPI (`packages/server/src/openapi.ts`) and the tool schemas
(`packages/sdk-ts/src/schemas.ts`) describe the same `ActionSpec` and are written
separately. Nothing obliges them to agree — except these tests.

This is the only honest use of a sibling projection: a cross-check, never a
source. Generating the Python from the OpenAPI would have turned each of its
errors into a truth; comparing against it instead reveals divergences in both
directions.
"""

from __future__ import annotations

from typing import Any

import pytest

from warrant_sdk import WARRANT_TOOLS, warrant_tool_by_name


def _action_spec_from_tool() -> dict[str, Any]:
    tool = warrant_tool_by_name("request_warrant")
    assert tool is not None
    return tool.input_schema["properties"]["actionSpec"]


def test_action_spec_fields_agree(openapi: dict[str, Any]) -> None:
    """Same field set, same required set, in both projections."""
    http = openapi["components"]["schemas"]["ActionSpec"]
    tool = _action_spec_from_tool()

    assert set(http["properties"]) == set(tool["properties"]), (
        "The OpenAPI ActionSpec and the tool ActionSpec do not declare the same fields. "
        "One of the two projections was changed without the other."
    )
    assert set(http["required"]) == set(tool["required"])


@pytest.mark.parametrize(
    ("field", "openapi_ref"),
    [("target", "Address"), ("calldata", "HexData"), ("registryRef", "Bytes32")],
)
def test_pattern_constrained_fields_agree(
    openapi: dict[str, Any], field: str, openapi_ref: str
) -> None:
    """The regexes must be equivalent, not merely both present.

    Compared after stripping non-capturing groups: Zod emits ``^0x(?:[0-9a-fA-F]{2})*$``
    and the OpenAPI is hand-written as ``^0x([0-9a-fA-F]{2})*$``. Same language, and
    the difference is not one an integrator can be hurt by — whereas a different
    character class or a different length is.
    """
    expected = openapi["components"]["schemas"][openapi_ref]["pattern"]
    actual = _action_spec_from_tool()["properties"][field]["pattern"]
    assert _normalize(actual) == _normalize(expected), (
        f"ActionSpec.{field}: the tool schema accepts {actual!r} while the Gateway's "
        f"OpenAPI advertises {expected!r}. An integrator reading the OpenAPI would build "
        "a value the tools reject, or the reverse."
    )


def test_value_is_a_decimal_string_in_both(openapi: dict[str, Any]) -> None:
    """``value`` is wei as a decimal string in both, never a number.

    A JSON number would lose precision above 2^53, and the whole point of the field
    is to be exact.
    """
    http = openapi["components"]["schemas"]["ActionSpec"]["properties"]["value"]
    tool = _action_spec_from_tool()["properties"]["value"]
    assert http["type"] == tool["type"] == "string"
    assert "0-9" in http["pattern"] and "0-9" in tool["pattern"]


def test_no_tool_input_declares_a_category_or_notional() -> None:
    """The rule, checked on the schemas rather than trusted to the prose.

    ``list_warrants`` does take a ``category`` — as a filter over already-derived
    categories, which is reading, not declaring. The rule is about what enters the
    price and the ``actionHash``, so it is checked where that happens: the action,
    and the arguments of the two tools that get priced.
    """
    for tool in WARRANT_TOOLS:
        properties = tool.input_schema.get("properties", {})
        action_spec = properties.get("actionSpec")
        if action_spec is not None:
            declared = set(action_spec.get("properties", {}))
            assert "category" not in declared, f"{tool.name}: actionSpec accepts a category"
            assert "notional" not in declared, f"{tool.name}: actionSpec accepts a notional"
            assert "notionalUSD" not in declared
            # The two priced tools take nothing beyond the action and the
            # beneficiary: any extra field would be a lever on the price.
            assert set(properties) <= {"actionSpec", "beneficiary"}, (
                f"{tool.name} accepts {sorted(set(properties) - {'actionSpec', 'beneficiary'})} "
                "in addition to the action — anything else is a lever on the bond."
            )
        assert "notional" not in properties, f"{tool.name}: accepts a notional"


def test_openapi_advertises_a_dynamic_price(openapi: dict[str, Any]) -> None:
    """The bond cannot be a fixed price, and the document must say so.

    ``clamp(minBond, riskBps × notionalUSD, maxBond)`` with a notional derived from
    the calldata: any fixed ``amount`` would be wrong for every action but one, and
    an agent pre-approving that amount would fail on its first real call.
    """
    price = openapi["paths"]["/v1/warrants"]["post"]["x-payment-info"]["price"]
    assert price["mode"] == "dynamic"
    assert price["quote"]["cost"] == "free", "knowing the price must cost nothing"
    assert "derived from the calldata" in price["basis"]


def _normalize(pattern: str) -> str:
    """Erase the non-capturing-group syntax; keep everything that changes the language."""
    return pattern.replace("(?:", "(")
