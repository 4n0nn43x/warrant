"""Shared fixtures. No test touches the network or a chain."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import pytest
from mock_gateway import BENEFICIARY, USDC, MockGateway, serve

from warrant_sdk import WarrantClient

#: Anvil account 1. Public, worthless.
DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
DEMO_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture
def action_spec() -> dict[str, Any]:
    """``transfer(0x…dEaD, 1_000_000)`` — 1 USDC on Base Sepolia."""
    return {
        "version": 1,
        "chainId": 84532,
        "target": USDC.lower(),
        "value": "0",
        "calldata": (
            "0xa9059cbb"
            "000000000000000000000000000000000000000000000000000000000000dead"
            "00000000000000000000000000000000000000000000000000000000000f4240"
        ),
        "registryRef": "0x" + "00" * 31 + "01",
    }


@pytest.fixture
def beneficiary() -> str:
    return BENEFICIARY


@pytest.fixture
def gateway() -> Iterator[tuple[str, MockGateway]]:
    """A mock Gateway on a free port. Yields ``(base_url, state)``.

    Port 0 on purpose: a Gateway already listening on 8402 must not make the suite
    fail for a reason that has nothing to do with the code under test.
    """
    server, state = serve(port=0, quiet=True)
    try:
        yield f"http://127.0.0.1:{server.server_port}", state
    finally:
        server.shutdown()


@pytest.fixture
def client(gateway: tuple[str, MockGateway]) -> WarrantClient:
    """A client with a signer — the paying configuration."""
    return WarrantClient(base_url=gateway[0], private_key=DEMO_KEY)


@pytest.fixture
def broke_client(gateway: tuple[str, MockGateway]) -> WarrantClient:
    """A client with no signer — the configuration that cannot spend."""
    return WarrantClient(base_url=gateway[0], private_key="")


@pytest.fixture(scope="session")
def openapi() -> dict[str, Any]:
    """The Gateway's own OpenAPI document, frozen by the generator."""
    return json.loads((FIXTURES / "openapi.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def manifest() -> dict[str, Any]:
    """The tool manifest, frozen by the generator."""
    return json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
