"""La CLI — c'est elle que la skill OpenClaw pilote.

Ce qui est vérifié ici n'est pas l'ergonomie mais le **contrat** : trois codes de
sortie distincts, et le résultat toujours sur stdout. Un appelant qui doit lire
stderr pour savoir pourquoi un appel a échoué finira par ne lire que stdout et
conclure que l'appel a réussi.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from conftest import DEMO_KEY

from warrant_sdk.cli import main


def _run(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, Any]:
    code = main(list(argv))
    out = capsys.readouterr().out
    try:
        return code, json.loads(out)
    except json.JSONDecodeError:
        return code, out


def test_tools_prints_the_manifest(capsys: pytest.CaptureFixture[str]) -> None:
    code, body = _run(capsys, "tools")
    assert code == 0
    assert [tool["name"] for tool in body["tools"]] == [
        "quote_risk",
        "request_warrant",
        "get_warrant",
        "list_warrants",
    ]
    assert body["manifest"].startswith("sha256:")
    # Le schéma publié est celui de la source, pas une reformulation.
    assert body["tools"][0]["inputSchema"]["properties"]["actionSpec"]["type"] == "object"


def test_a_free_call_exits_zero(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    gateway: tuple[str, Any],
    action_spec: dict[str, Any],
) -> None:
    monkeypatch.setenv("WARRANT_BASE_URL", gateway[0])
    monkeypatch.delenv("WARRANT_PRIVATE_KEY", raising=False)
    code, body = _run(capsys, "call", "quote_risk", json.dumps({"actionSpec": action_spec}))
    assert code == 0
    assert body["category"] == "erc20.transfer"


def test_payment_required_exits_two(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    gateway: tuple[str, Any],
    action_spec: dict[str, Any],
    beneficiary: str,
) -> None:
    """Exit code 2, not 1.

    "The bond costs 1 USDC, decide" and "your calldata is malformed" call for
    different reactions, so they get different codes.
    """
    monkeypatch.setenv("WARRANT_BASE_URL", gateway[0])
    monkeypatch.delenv("WARRANT_PRIVATE_KEY", raising=False)
    code, body = _run(
        capsys,
        "call",
        "request_warrant",
        json.dumps({"actionSpec": action_spec, "beneficiary": beneficiary}),
    )
    assert code == 2
    assert body["paymentRequired"]["x402Version"] == 2
    assert "WARRANT_PRIVATE_KEY" in body["hint"]


def test_a_paid_call_with_a_key_exits_zero(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    gateway: tuple[str, Any],
    action_spec: dict[str, Any],
    beneficiary: str,
) -> None:
    monkeypatch.setenv("WARRANT_BASE_URL", gateway[0])
    monkeypatch.setenv("WARRANT_PRIVATE_KEY", DEMO_KEY)
    code, body = _run(
        capsys,
        "call",
        "request_warrant",
        json.dumps({"actionSpec": action_spec, "beneficiary": beneficiary}),
    )
    assert code == 0
    assert body["warrantId"].startswith("0x")
    assert body["settlement"]["success"] is True


def test_an_error_exits_one_with_a_hint_on_stdout(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    gateway: tuple[str, Any],
) -> None:
    monkeypatch.setenv("WARRANT_BASE_URL", gateway[0])
    code, body = _run(capsys, "call", "get_warrant", json.dumps({"warrantId": "nope"}))
    assert code == 1
    assert body["error"]["code"] == "invalid_input"
    assert body["error"]["field"] == "$.warrantId"
    assert body["error"]["hint"]


def test_arguments_can_come_from_a_file(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    gateway: tuple[str, Any],
    action_spec: dict[str, Any],
    tmp_path: Any,
) -> None:
    """An ``actionSpec`` carries full calldata; the inline form hits shell quoting first."""
    monkeypatch.setenv("WARRANT_BASE_URL", gateway[0])
    path = tmp_path / "args.json"
    path.write_text(json.dumps({"actionSpec": action_spec}), encoding="utf-8")
    code, body = _run(capsys, "call", "quote_risk", f"@{path}")
    assert code == 0
    assert body["bond"] == "1000000"


def test_malformed_json_says_so(capsys: pytest.CaptureFixture[str]) -> None:
    code, body = _run(capsys, "call", "quote_risk", "{not json")
    assert code == 1
    assert body["error"]["code"] == "invalid_input"
    assert "stdin" in body["error"]["hint"]


def test_help_and_version_exit_zero(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--help"]) == 0
    capsys.readouterr()
    code, body = _run(capsys, "--version")
    assert code == 0
    assert body["manifest"].startswith("sha256:")
