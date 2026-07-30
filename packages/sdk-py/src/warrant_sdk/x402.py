"""x402 v2 wire types, and the one thing about Warrant that surprises integrators.

Warrant funds a bond with an **EIP-3009 ``ReceiveWithAuthorization``**
authorization signed by the agent, and the authorization's ``nonce`` must equal
the hash of the warrant's terms. Both points depart from what a stock x402
``exact`` client does, and both fail silently if you get them wrong:

* ``TransferWithAuthorization`` — what most x402 ``exact`` implementations sign —
  carries the *same six fields* as ``ReceiveWithAuthorization`` and produces a
  different typehash, hence a different digest, hence a signature the token
  rejects. Nothing in the payload records which of the two was signed. You learn
  about it from a reverted transaction whose reason names nothing you sent —
  ``FiatTokenV2: invalid signature`` on Circle's USDC, ``InvalidSignature()`` on
  tokens with custom errors.
  ``WarrantEscrow.open`` calls the ``receive`` variant on purpose: it requires
  ``to == msg.sender``, so no third party can submit the authorization to the
  token first and burn the nonce out from under a legitimate open. The 402 says so
  twice — ``accepts[0].extra.primaryType == "ReceiveWithAuthorization"`` and
  ``accepts[0].extra.assetTransferMethod == "eip3009-receive"``, *not* the spec's
  ``"eip3009"``, which names the transfer variant — and
  :class:`Eip3009Signer` refuses to sign unless both agree with what it can
  produce.
* The ``nonce`` is **not random**. EIP-3009 signs six fields, none of which says
  *which warrant* is being funded — so an ``opener`` holding an authorization
  could once have opened terms of its own choosing. Constraining the nonce to
  ``termsHash(...)`` makes signing the payment the same act as signing the terms.
  Get it wrong and the escrow reverts with ``TermsMismatch()``.

Everything needed to compute that nonce is published in the 402 challenge, under
``extensions["warrant/commitment"].info``. :class:`Eip3009Signer` reads it from
there; it never guesses.
"""

from __future__ import annotations

import time
from typing import Any, Protocol, runtime_checkable

from .errors import WarrantError

__all__ = [
    "X402_VERSION",
    "RECEIVE_AUTHORIZATION_TRANSFER_METHOD",
    "RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE",
    "RECEIVE_WITH_AUTHORIZATION_TYPES",
    "WARRANT_COMMITMENT_EXTENSION",
    "PaymentSigner",
    "Eip3009Signer",
    "is_payment_required",
    "commitment_terms",
    "terms_hash_of",
    "warrant_id_of",
]

#: Protocol version. v1 (``X-PAYMENT``) is not supported.
X402_VERSION = 2

#: EIP-712 primary type the token must see. Not ``TransferWithAuthorization``.
RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE = "ReceiveWithAuthorization"

#: Value the Gateway announces in ``accepts[0].extra.assetTransferMethod``.
#:
#: The x402 ``exact`` scheme says this field, *if present, MUST be* ``"eip3009"`` —
#: and there ``eip3009`` unambiguously means ``transferWithAuthorization``. Warrant
#: announces ``"eip3009-receive"`` instead, as a deliberate, documented extension:
#: the escrow consumes ``receiveWithAuthorization``, whose ``to == msg.sender``
#: constraint is what stops a third party from spending your authorization first.
#: Announcing ``"eip3009"`` would be *false*, and a spec-conformant client would
#: sign the wrong typehash. Anything other than this value — including the bare
#: ``"eip3009"`` — is refused here rather than signed.
RECEIVE_AUTHORIZATION_TRANSFER_METHOD = "eip3009-receive"

#: Field order is part of the typehash — a moved field yields a signature that is
#: valid for a message nobody will ever verify.
RECEIVE_WITH_AUTHORIZATION_TYPES: dict[str, list[dict[str, str]]] = {
    "ReceiveWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ]
}

#: x402 extension under which the Gateway publishes the warrant terms.
WARRANT_COMMITMENT_EXTENSION = "warrant/commitment"


# ─────────────────────────────────────────────────────────────────────────────
# Recognising the wire objects
# ─────────────────────────────────────────────────────────────────────────────


def is_payment_required(value: Any) -> bool:
    """Structural recognition of an x402 ``PaymentRequired``.

    Structural rather than schema-based, on purpose: the far side may announce
    ``extensions`` we know nothing about, and rejecting those would break the
    forward compatibility the specification asks for.
    """
    if not isinstance(value, dict):
        return False
    return (
        value.get("x402Version") == X402_VERSION
        and isinstance(value.get("accepts"), list)
        and isinstance(value.get("resource"), dict)
    )


def commitment_terms(payment_required: dict[str, Any]) -> dict[str, Any]:
    """Extract the warrant terms the agent is about to sign.

    Raises:
        WarrantError: ``payment_invalid`` when the challenge carries no
            ``warrant/commitment`` extension. Refusing here beats signing an
            authorization whose nonce cannot possibly match: the escrow would
            revert with ``TermsMismatch()``, which says nothing about *why*.
    """
    extensions = payment_required.get("extensions") or {}
    commitment = extensions.get(WARRANT_COMMITMENT_EXTENSION) or {}
    info = commitment.get("info")
    if not isinstance(info, dict):
        raise WarrantError(
            "payment_invalid",
            "The 402 challenge carries no `warrant/commitment` extension, so the "
            "terms that the EIP-3009 nonce must hash are unknown.",
            hint=(
                "This Gateway is either not a Warrant Gateway or predates the "
                "termsHash binding. Check WARRANT_BASE_URL, then GET /openapi.json "
                "and look for `x-payment-info`."
            ),
            details=payment_required,
        )
    missing = [
        key
        for key in ("nonce", "beneficiary", "bond", "conditionHash", "actionHash", "duration")
        if info.get(key) is None
    ]
    if missing:
        raise WarrantError(
            "payment_invalid",
            f"Incomplete warrant terms in the 402 challenge: {', '.join(missing)} missing.",
            hint=(
                "All six terms are needed to compute termsHash. Without them the "
                "authorization nonce cannot be derived and open() would revert."
            ),
            details=info,
        )
    return info


# ─────────────────────────────────────────────────────────────────────────────
# The two hashes, exact mirrors of the contract
# ─────────────────────────────────────────────────────────────────────────────


def _bytes32(value: str, field: str) -> bytes:
    raw = value[2:] if value.startswith(("0x", "0X")) else value
    if len(raw) != 64:
        raise WarrantError(
            "payment_invalid",
            f"{field}: 32 bytes expected, got {len(raw) // 2}.",
            field=f"$.{field}",
        )
    return bytes.fromhex(raw)


def warrant_id_of(agent: str, nonce: int | str, action_hash: str) -> str:
    """``keccak256(abi.encode(agent, nonce, actionHash))`` — the warrant id.

    Mirror of ``warrantIdOf`` in ``packages/server/src/gateway.ts``. The Gateway
    cannot compute it for us: it does not know which address will sign.
    """
    from eth_abi import encode
    from eth_utils import keccak

    value = int(nonce, 16) if isinstance(nonce, str) else int(nonce)
    packed = encode(
        ["address", "uint256", "bytes32"],
        [agent, value, _bytes32(action_hash, "actionHash")],
    )
    return "0x" + keccak(packed).hex()


def terms_hash_of(
    *,
    warrant_id: str,
    beneficiary: str,
    bond: str | int,
    condition_hash: str,
    action_hash: str,
    duration: int,
) -> str:
    """``keccak256(abi.encode(id, beneficiary, bond, conditionHash, actionHash, duration))``.

    Exact mirror of ``WarrantEscrow.termsHash``, and the value the EIP-3009
    ``nonce`` must carry. The ``uint64`` on ``duration`` is not cosmetic — a
    ``uint256`` encoding of the same number produces the same 32-byte word here,
    but the contract's ABI declares ``uint64`` and a future field reordering would
    diverge silently if this list did not match it exactly.
    """
    from eth_abi import encode
    from eth_utils import keccak

    packed = encode(
        ["bytes32", "address", "uint256", "bytes32", "bytes32", "uint64"],
        [
            _bytes32(warrant_id, "warrantId"),
            beneficiary,
            int(bond),
            _bytes32(condition_hash, "conditionHash"),
            _bytes32(action_hash, "actionHash"),
            int(duration),
        ],
    )
    return "0x" + keccak(packed).hex()


# ─────────────────────────────────────────────────────────────────────────────
# Signataires
# ─────────────────────────────────────────────────────────────────────────────


@runtime_checkable
class PaymentSigner(Protocol):
    """All the SDK asks of a wallet.

    The SDK holds no key and wants none. Implement this against a KMS, a hardware
    signer or a remote service; :class:`Eip3009Signer` is only the local-key case.
    """

    @property
    def address(self) -> str:
        """The address that will fund the bond, lowercase and 0x-prefixed."""
        ...

    def create_payment(self, payment_required: dict[str, Any]) -> dict[str, Any]:
        """Turn a 402 challenge into an x402 ``PaymentPayload``."""
        ...


class Eip3009Signer:
    """Signs the bond authorization with a local private key.

    Reads what to sign from the challenge — ``accepts[0].extra.primaryType`` and
    ``accepts[0].extra.assetTransferMethod`` — rather than assuming it, and refuses
    anything other than ``ReceiveWithAuthorization`` / ``eip3009-receive``: signing
    a type we cannot verify would produce a payload that looks correct and reverts
    onchain with a reason that names nothing we sent (``FiatTokenV2: invalid
    signature``).
    """

    def __init__(self, private_key: str) -> None:
        from eth_account import Account

        self._account = Account.from_key(private_key)

    @property
    def address(self) -> str:
        return self._account.address.lower()

    def create_payment(self, payment_required: dict[str, Any]) -> dict[str, Any]:
        """Build the ``PaymentPayload`` for a Warrant 402 challenge.

        Raises:
            WarrantError: ``payment_invalid`` when the challenge is unusable — an
                unsupported primary type, a missing EIP-712 token domain, or terms
                that contradict the amount being requested.
        """
        from eth_account.messages import encode_typed_data

        accepts = payment_required.get("accepts") or []
        if not accepts:
            raise WarrantError(
                "payment_invalid",
                "402 challenge with an empty `accepts` list: nothing to pay.",
                details=payment_required,
            )
        requirements = accepts[0]
        extra = requirements.get("extra") or {}

        primary_type = extra.get("primaryType", RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE)
        if primary_type != RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE:
            raise WarrantError(
                "payment_invalid",
                f"The challenge asks for primaryType {primary_type!r}; this signer only "
                f"produces {RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE!r}.",
                hint=(
                    "Warrant's escrow calls receiveWithAuthorization, so the receive "
                    "variant is the only one it can consume. A Gateway asking for "
                    "TransferWithAuthorization is misconfigured."
                ),
                details=requirements,
            )

        # Two fields say the same thing, and both must be checked: an
        # `assetTransferMethod: "eip3009"` alongside a receive `primaryType` is a
        # 402 that contradicts itself. Picking one of the two at random means
        # choosing, on the server's behalf, which typehash the token will see.
        transfer_method = extra.get("assetTransferMethod", RECEIVE_AUTHORIZATION_TRANSFER_METHOD)
        if transfer_method != RECEIVE_AUTHORIZATION_TRANSFER_METHOD:
            raise WarrantError(
                "payment_invalid",
                f"The challenge announces assetTransferMethod {transfer_method!r}; this "
                f"signer only produces {RECEIVE_AUTHORIZATION_TRANSFER_METHOD!r} "
                f"({RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE}).",
                hint=(
                    "`eip3009` means transferWithAuthorization in the x402 exact scheme, "
                    "and Warrant's escrow cannot consume it: receiveWithAuthorization "
                    "requires to == msg.sender, which is what keeps a third party from "
                    "spending the authorization first. A Warrant Gateway announces "
                    "`eip3009-receive`; anything else is either not a Warrant Gateway or "
                    "is misconfigured."
                ),
                details=requirements,
            )

        terms = commitment_terms(payment_required)

        # The price comes from the server twice: `accepts[0].amount` and
        # `terms.bond`. They must agree — otherwise we do not know which one we
        # are signing, and the contract does not forgive that kind of ambiguity.
        if int(terms["bond"]) != int(requirements["amount"]):
            raise WarrantError(
                "payment_invalid",
                f"The challenge quotes {requirements['amount']} in `accepts[0].amount` "
                f"but {terms['bond']} in the committed terms.",
                hint="Refuse to sign: one of the two values would be committed and we cannot tell which.",
                details={"requirements": requirements, "terms": terms},
            )

        chain_id = _chain_id_of(requirements.get("network", ""))
        name = extra.get("name")
        version = extra.get("version")
        if not name or not version:
            raise WarrantError(
                "payment_invalid",
                "402 challenge without the token's EIP-712 domain (`extra.name`, `extra.version`).",
                hint=(
                    "EIP-3009 signs against the *token's* domain, not the escrow's. A "
                    "one-character difference in `name` changes the digest and the token "
                    "refuses the signature."
                ),
                details=extra,
            )

        agent = self.address
        warrant_id = warrant_id_of(agent, terms["nonce"], terms["actionHash"])
        auth_nonce = terms_hash_of(
            warrant_id=warrant_id,
            beneficiary=terms["beneficiary"],
            bond=terms["bond"],
            condition_hash=terms["conditionHash"],
            action_hash=terms["actionHash"],
            duration=int(terms["duration"]),
        )

        valid_after = 0
        valid_before = int(time.time()) + int(requirements.get("maxTimeoutSeconds") or 60)

        message = {
            "from": agent,
            # `to` is the escrow: the contract passes `address(this)` to the
            # token, and a different `to` would give `CallerMustBePayee()`.
            "to": requirements["payTo"],
            "value": int(requirements["amount"]),
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": _bytes32(auth_nonce, "authorizationNonce"),
        }
        signable = encode_typed_data(
            domain_data={
                "name": name,
                "version": version,
                "chainId": chain_id,
                "verifyingContract": requirements["asset"],
            },
            message_types=RECEIVE_WITH_AUTHORIZATION_TYPES,
            message_data=message,
        )
        signed = self._account.sign_message(signable)

        return {
            "x402Version": X402_VERSION,
            "resource": {"url": (payment_required.get("resource") or {}).get("url", "")},
            "accepted": requirements,
            "payload": {
                "signature": "0x" + signed.signature.hex().removeprefix("0x"),
                "authorization": {
                    "from": agent,
                    "to": requirements["payTo"],
                    "value": str(requirements["amount"]),
                    "validAfter": str(valid_after),
                    "validBefore": str(valid_before),
                    "nonce": auth_nonce,
                },
            },
            "extensions": {},
        }


def _chain_id_of(network: str) -> int:
    """CAIP-2 ``eip155:84532`` → ``84532``.

    A bare chain id is refused: the network is what decides which chain the
    signature is valid on, and guessing it wrong is not recoverable.
    """
    if not network.startswith("eip155:"):
        raise WarrantError(
            "payment_invalid",
            f"Unsupported network identifier {network!r}: CAIP-2 `eip155:<chainId>` expected.",
            details=network,
        )
    return int(network.split(":", 1)[1])
