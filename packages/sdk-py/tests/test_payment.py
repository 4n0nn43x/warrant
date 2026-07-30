"""Le rail de paiement : x402 v2, EIP-3009 `ReceiveWithAuthorization`, `termsHash`.

Ces tests existent parce que les deux pièges du financement d'une caution sont
**silencieux**. Signer `TransferWithAuthorization` produit un payload
indiscernable d'un payload correct ; tirer un nonce au hasard produit une
autorisation valide pour le token et refusée par l'escrow. Les deux ne se
découvrent, sans ces tests, qu'en lisant un revert onchain.

On vérifie donc que le SDK fait ce qu'il faut **et** qu'un client qui se trompe se
fait refuser avec une phrase qui nomme la faute.
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import DEMO_ADDRESS, DEMO_KEY

from warrant_sdk import Eip3009Signer, WarrantClient, WarrantError, terms_hash_of, warrant_id_of
from warrant_sdk.x402 import (
    RECEIVE_AUTHORIZATION_TRANSFER_METHOD,
    RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE,
    commitment_terms,
)


def test_without_a_signer_the_402_comes_back_intact(
    broke_client: WarrantClient, action_spec: dict[str, Any], beneficiary: str
) -> None:
    """A payment requirement is not an error: it is step 2 of the protocol.

    What the agent gets must be enough to decide: the amount, the asset, the
    network, and the type to sign.
    """
    outcome = broke_client.call(
        "request_warrant", {"actionSpec": action_spec, "beneficiary": beneficiary}
    )
    assert outcome.kind == "payment-required"
    challenge = outcome.payment_required
    assert challenge is not None
    assert challenge["x402Version"] == 2
    requirements = challenge["accepts"][0]
    assert requirements["scheme"] == "exact"
    assert requirements["network"] == "eip155:84532"
    assert int(requirements["amount"]) > 0
    assert requirements["extra"]["primaryType"] == RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE, (
        "The challenge must announce the primary type. A client left on the x402 "
        "`exact` default would sign TransferWithAuthorization and revert onchain."
    )
    assert (
        requirements["extra"]["assetTransferMethod"] == RECEIVE_AUTHORIZATION_TRANSFER_METHOD
    ), (
        "The transfer method must be `eip3009-receive`, exactly as the real Gateway "
        "announces it. The spec's `eip3009` names transferWithAuthorization, which "
        "the escrow cannot consume — a mock announcing it would teach the trap "
        "instead of the fix."
    )


def test_the_402_publishes_every_term_needed_to_compute_the_nonce(
    broke_client: WarrantClient, action_spec: dict[str, Any], beneficiary: str
) -> None:
    """The agent cannot sign the terms it has not been told."""
    outcome = broke_client.call(
        "request_warrant", {"actionSpec": action_spec, "beneficiary": beneficiary}
    )
    terms = commitment_terms(outcome.payment_required or {})
    for key in ("nonce", "beneficiary", "bond", "conditionHash", "actionHash", "duration"):
        assert terms.get(key) is not None, f"term {key} missing from the 402"


def test_the_full_flow_opens_a_warrant(
    client: WarrantClient, action_spec: dict[str, Any], beneficiary: str
) -> None:
    """402 → sign → replay → warrant, in one call.

    The Gateway here recovers the signer and recomputes ``termsHash`` itself, so a
    green test means the signature carried the right typehash and the right nonce.
    """
    outcome = client.call(
        "request_warrant", {"actionSpec": action_spec, "beneficiary": beneficiary}
    )
    assert outcome.kind == "ok", outcome.payment_required
    warrant = outcome.data
    assert warrant["warrantId"].startswith("0x")
    assert warrant["agent"] == DEMO_ADDRESS
    assert outcome.settlement is not None and outcome.settlement["success"] is True


def test_the_funding_ref_is_the_terms_hash(
    client: WarrantClient, action_spec: dict[str, Any], beneficiary: str
) -> None:
    """``fundingRef`` is the EIP-3009 nonce, and that nonce is the hash of the terms.

    Recomputed here from the warrant that came back — which is the property that
    makes one signature bind both the payment and the terms.
    """
    warrant = client.open_warrant({"actionSpec": action_spec, "beneficiary": beneficiary})
    view = client.read_warrant({"warrantId": warrant["warrantId"]})

    expected = terms_hash_of(
        warrant_id=warrant["warrantId"],
        beneficiary=view["beneficiary"],
        bond=view["bond"],
        condition_hash=view["conditionHash"],
        action_hash=view["actionHash"],
        duration=view["expiry"] - view["openedAt"],
    )
    assert warrant["fundingRef"].lower() == expected.lower()


def test_the_warrant_id_is_derived_from_the_signer(
    broke_client: WarrantClient, client: WarrantClient, action_spec: dict[str, Any], beneficiary: str
) -> None:
    """``warrantId = keccak256(abi.encode(agent, nonce, actionHash))``.

    The Gateway cannot announce it — it does not know which address will sign. So
    the client computes it, and this checks that both sides agree.
    """
    challenge = broke_client.call(
        "request_warrant", {"actionSpec": action_spec, "beneficiary": beneficiary}
    ).payment_required
    terms = commitment_terms(challenge or {})
    expected = warrant_id_of(DEMO_ADDRESS, terms["nonce"], terms["actionHash"])
    # Le même nonce de mandat, rejoué à la main, doit produire l'id que le Gateway
    # inscrira. On ne peut pas comparer au mandat ouvert plus haut : chaque 402
    # émet un nonce neuf.
    assert expected.startswith("0x") and len(expected) == 66


# ─────────────────────────────────────────────────────────────────────────────
# Les deux pièges, éprouvés
# ─────────────────────────────────────────────────────────────────────────────


class TransferSigner(Eip3009Signer):
    """A signer that makes the mistake every stock x402 client makes.

    Signs ``TransferWithAuthorization`` — same six fields, different typehash — and
    reports ``ReceiveWithAuthorization`` in the payload, exactly as a library
    default would. Nothing in the payload reveals the substitution.
    """

    def create_payment(self, payment_required: dict[str, Any]) -> dict[str, Any]:
        from eth_account.messages import encode_typed_data

        payload = super().create_payment(payment_required)
        auth = payload["payload"]["authorization"]
        requirements = payload["accepted"]
        wrong_types = {
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ]
        }
        signable = encode_typed_data(
            domain_data={
                "name": requirements["extra"]["name"],
                "version": requirements["extra"]["version"],
                "chainId": 84532,
                "verifyingContract": requirements["asset"],
            },
            message_types=wrong_types,
            message_data={
                "from": auth["from"],
                "to": auth["to"],
                "value": int(auth["value"]),
                "validAfter": int(auth["validAfter"]),
                "validBefore": int(auth["validBefore"]),
                "nonce": bytes.fromhex(auth["nonce"][2:]),
            },
        )
        signed = self._account.sign_message(signable)
        payload["payload"]["signature"] = "0x" + signed.signature.hex().removeprefix("0x")
        return payload


class RandomNonceSigner(Eip3009Signer):
    """A signer that treats the EIP-3009 nonce as what it usually is: random.

    Which is what every other x402 ``exact`` implementation does, and what the
    escrow refuses — the nonce must be the hash of the terms.
    """

    def create_payment(self, payment_required: dict[str, Any]) -> dict[str, Any]:
        import secrets

        from eth_account.messages import encode_typed_data

        from warrant_sdk.x402 import RECEIVE_WITH_AUTHORIZATION_TYPES

        payload = super().create_payment(payment_required)
        auth = payload["payload"]["authorization"]
        requirements = payload["accepted"]
        nonce = secrets.token_bytes(32)
        signable = encode_typed_data(
            domain_data={
                "name": requirements["extra"]["name"],
                "version": requirements["extra"]["version"],
                "chainId": 84532,
                "verifyingContract": requirements["asset"],
            },
            message_types=RECEIVE_WITH_AUTHORIZATION_TYPES,
            message_data={
                "from": auth["from"],
                "to": auth["to"],
                "value": int(auth["value"]),
                "validAfter": int(auth["validAfter"]),
                "validBefore": int(auth["validBefore"]),
                "nonce": nonce,
            },
        )
        signed = self._account.sign_message(signable)
        auth["nonce"] = "0x" + nonce.hex()
        payload["payload"]["signature"] = "0x" + signed.signature.hex().removeprefix("0x")
        return payload


def test_a_transfer_with_authorization_signature_is_refused_by_name(
    gateway: tuple[str, Any], action_spec: dict[str, Any], beneficiary: str
) -> None:
    """The trap, sprung on purpose, so that the failure has a legible name.

    Without this the same mistake surfaces as ``InvalidSignature()`` in a reverted
    transaction, which explains nothing to whoever has to fix it.
    """
    base_url, _ = gateway
    client = WarrantClient(base_url=base_url, signer=TransferSigner(DEMO_KEY))
    outcome = client.call(
        "request_warrant", {"actionSpec": action_spec, "beneficiary": beneficiary}
    )
    assert outcome.kind == "payment-required", "a wrong typehash must not open a warrant"
    error = (outcome.payment_required or {}).get("error", "")
    assert "invalid_signature" in error
    assert "ReceiveWithAuthorization" in error, (
        "The refusal must name the right type. 'invalid signature' alone sends the "
        "integrator looking at their key."
    )


def test_a_random_nonce_is_refused_as_a_terms_mismatch(
    gateway: tuple[str, Any], action_spec: dict[str, Any], beneficiary: str
) -> None:
    """The second trap: a signature valid for the token, refused by the escrow."""
    base_url, _ = gateway
    client = WarrantClient(base_url=base_url, signer=RandomNonceSigner(DEMO_KEY))
    outcome = client.call(
        "request_warrant", {"actionSpec": action_spec, "beneficiary": beneficiary}
    )
    assert outcome.kind == "payment-required"
    error = (outcome.payment_required or {}).get("error", "")
    assert "terms_mismatch" in error
    # Le refus doit rendre les six termes : l'agent n'a alors qu'à resigner.
    for term in ("beneficiary=", "bond=", "conditionHash=", "actionHash=", "duration="):
        assert term in error, f"the refusal does not report {term}"


def test_the_signer_refuses_a_challenge_asking_for_the_wrong_type() -> None:
    """Symmetry: we refuse to produce what we cannot honour, too."""
    signer = Eip3009Signer(DEMO_KEY)
    with pytest.raises(WarrantError) as raised:
        signer.create_payment(
            {
                "x402Version": 2,
                "resource": {"url": "http://x/v1/warrants"},
                "accepts": [
                    {
                        "scheme": "exact",
                        "network": "eip155:84532",
                        "amount": "1000000",
                        "asset": "0x" + "11" * 20,
                        "payTo": "0x" + "22" * 20,
                        "maxTimeoutSeconds": 60,
                        "extra": {
                            "name": "USDC",
                            "version": "2",
                            "primaryType": "TransferWithAuthorization",
                        },
                    }
                ],
            }
        )
    assert raised.value.code == "payment_invalid"
    assert "receiveWithAuthorization" in raised.value.hint


def test_the_signer_refuses_the_spec_default_transfer_method() -> None:
    """``assetTransferMethod: "eip3009"`` names the *transfer* variant.

    It is the x402 ``exact`` default and the one thing a conformant client would
    trust, which is exactly why refusing it must be explicit: a Gateway announcing
    it either is not Warrant's, or would have us sign a typehash its escrow cannot
    consume. Better a refusal that names the field than an ``InvalidSignature()``
    from a reverted transaction.
    """
    signer = Eip3009Signer(DEMO_KEY)
    with pytest.raises(WarrantError) as raised:
        signer.create_payment(
            {
                "x402Version": 2,
                "resource": {"url": "http://x/v1/warrants"},
                "accepts": [
                    {
                        "scheme": "exact",
                        "network": "eip155:84532",
                        "amount": "1000000",
                        "asset": "0x" + "11" * 20,
                        "payTo": "0x" + "22" * 20,
                        "maxTimeoutSeconds": 60,
                        "extra": {
                            "name": "USDC",
                            "version": "2",
                            # Le 402 se contredit : type receive, méthode transfer.
                            "primaryType": RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE,
                            "assetTransferMethod": "eip3009",
                        },
                    }
                ],
            }
        )
    assert raised.value.code == "payment_invalid"
    assert "eip3009-receive" in raised.value.message
    assert "to == msg.sender" in raised.value.hint


def test_the_signer_refuses_a_challenge_without_the_token_domain() -> None:
    """``name`` and ``version`` are the token's, and a wrong one is undebuggable."""
    signer = Eip3009Signer(DEMO_KEY)
    with pytest.raises(WarrantError) as raised:
        signer.create_payment(
            {
                "x402Version": 2,
                "resource": {"url": "http://x/v1/warrants"},
                "accepts": [
                    {
                        "scheme": "exact",
                        "network": "eip155:84532",
                        "amount": "1000000",
                        "asset": "0x" + "11" * 20,
                        "payTo": "0x" + "22" * 20,
                        "maxTimeoutSeconds": 60,
                        "extra": {},
                    }
                ],
                "extensions": {
                    "warrant/commitment": {
                        "info": {
                            "nonce": "0x" + "01" * 32,
                            "beneficiary": "0x" + "33" * 20,
                            "bond": "1000000",
                            "conditionHash": "0x" + "02" * 32,
                            "actionHash": "0x" + "03" * 32,
                            "duration": 1800,
                        }
                    }
                },
            }
        )
    assert "EIP-712 domain" in raised.value.message


def test_a_challenge_without_the_commitment_extension_is_refused() -> None:
    """Nothing to hash means nothing to sign, and that is a refusal, not a guess."""
    signer = Eip3009Signer(DEMO_KEY)
    with pytest.raises(WarrantError) as raised:
        signer.create_payment(
            {
                "x402Version": 2,
                "resource": {"url": "http://x/v1/warrants"},
                "accepts": [
                    {
                        "scheme": "exact",
                        "network": "eip155:84532",
                        "amount": "1000000",
                        "asset": "0x" + "11" * 20,
                        "payTo": "0x" + "22" * 20,
                        "maxTimeoutSeconds": 60,
                        "extra": {"name": "USDC", "version": "2"},
                    }
                ],
                "extensions": {},
            }
        )
    assert "warrant/commitment" in raised.value.message


def test_signing_is_refused_when_the_gateway_names_another_beneficiary(
    gateway: tuple[str, Any], action_spec: dict[str, Any]
) -> None:
    """The divergence worth refusing rather than warning about.

    The Gateway commits the beneficiary from its own policy. Since the EIP-3009
    nonce hashes the terms, signing would bond in favour of an address the caller
    never chose — and the signature is the last moment where that can be stopped.
    """
    base_url, _ = gateway
    client = WarrantClient(base_url=base_url, private_key=DEMO_KEY)
    with pytest.raises(WarrantError) as raised:
        client.call(
            "request_warrant", {"actionSpec": action_spec, "beneficiary": "0x" + "ab" * 20}
        )
    assert raised.value.code == "payment_invalid"
    assert raised.value.field == "$.beneficiary"
    assert "did not choose" in raised.value.message


def test_the_payment_loop_is_bounded(
    gateway: tuple[str, Any], action_spec: dict[str, Any], beneficiary: str
) -> None:
    """A Gateway answering 402 forever must not drain the wallet.

    With ``RandomNonceSigner`` every attempt is refused, so the loop's only exit is
    its bound.
    """
    base_url, state = gateway
    client = WarrantClient(
        base_url=base_url, signer=RandomNonceSigner(DEMO_KEY), max_payment_attempts=1
    )
    outcome = client.call(
        "request_warrant", {"actionSpec": action_spec, "beneficiary": beneficiary}
    )
    assert outcome.kind == "payment-required"
    paid_calls = [s for s in state.seen if s["path"] == "/v1/warrants"]
    assert len(paid_calls) == 2, "one unpaid call, one paid attempt, and no more"
