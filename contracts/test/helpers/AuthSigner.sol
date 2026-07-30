// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WarrantEscrow} from "../../src/WarrantEscrow.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @title AuthSigner — a factory for signed EIP-3009 authorizations
/// @notice Since the fix, `open` no longer takes an agent address: it is *derived*
///         from the signature. The whole suite must therefore produce genuine
///         ECDSA signatures, and agents stop being mere `makeAddr` results to
///         become accounts that carry a key (`makeAddrAndKey`).
/// @dev    The common factor of the three test files — unit, invariants and PoC
///         all sign exactly the same digest. Duplicating it three times would
///         mean accepting the risk that one of the copies drifts from the token's
///         EIP-712 domain: a test would then fail for a reason unrelated to the
///         contract under audit, which is the worst kind of false positive.
///
///         `from` and `key` are deliberately **independent** parameters: that is
///         what lets the PoCs build a *forged* authorization (a `from` address
///         one merely claims, a key that is not its own) and prove that the token
///         rejects it.
abstract contract AuthSigner is Test {
    /// @dev Time bounds deliberately wide by default. `validAfter = 0` because the
    ///      token requires `block.timestamp > validAfter` — a strict bound, which a
    ///      `validAfter` equal to the current instant would fail. `validBefore` at
    ///      its maximum because the suite warps up to +365 days, and an expired
    ///      authorization would mask the property under test.
    uint256 internal constant VALID_AFTER = 0;
    uint256 internal constant VALID_BEFORE = type(uint256).max;

    /// @dev Rebuilds the EIP-712 digest of `ReceiveWithAuthorization` exactly as
    ///      the token will recompute it. `to` is a parameter rather than
    ///      `address(this)`: it is what binds the authorization to the escrow, and
    ///      the anti-interception PoC needs to tamper with it.
    function _digest(MockUSDC token, address to, WarrantEscrow.Authorization memory a)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        a.from,
                        to,
                        a.value,
                        a.validAfter,
                        a.validBefore,
                        a.nonce
                    )
                )
            )
        );
    }

    /// @notice An authorization with an explicit time window.
    /// @param from  the address *declared* as the authorizer.
    /// @param key   the key that actually signs. If it does not match `from`, the
    ///              authorization is a forgery and the token must revert with
    ///              `InvalidSignature`.
    function _authWindow(
        MockUSDC token,
        address to,
        address from,
        uint256 key,
        uint256 value,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore
    ) internal view returns (WarrantEscrow.Authorization memory auth) {
        auth = WarrantEscrow.Authorization({
            from: from,
            value: value,
            validAfter: validAfter,
            validBefore: validBefore,
            nonce: nonce,
            v: 0,
            r: bytes32(0),
            s: bytes32(0)
        });
        (auth.v, auth.r, auth.s) = vm.sign(key, _digest(token, to, auth));
    }

    /// @notice The common case: window wide open, authorization addressed to `to`,
    ///         nonce imposed by the caller. Reserved for tests that must produce a
    ///         nonce **not matching** the terms, hence rejected by `TermsMismatch`.
    function _auth(MockUSDC token, address to, address from, uint256 key, uint256 value, bytes32 nonce)
        internal
        view
        returns (WarrantEscrow.Authorization memory)
    {
        return _authWindow(token, to, from, key, value, nonce, VALID_AFTER, VALID_BEFORE);
    }

    /// @notice The terms of a warrant, as `termsHash` commits to them.
    /// @dev    Grouped into a struct for one practical reason and one substantive
    ///         one. Practical: six more parameters in every helper pushed the
    ///         invariant handler into "stack too deep". Substantive: those six
    ///         values no longer form an argument list but **a single object**, the
    ///         one the agent signs. Pulling them apart in the tests would amount
    ///         to denying the very property we are trying to verify.
    struct Terms {
        bytes32 id;
        address beneficiary;
        uint256 bond;
        bytes32 conditionHash;
        bytes32 actionHash;
        uint64 duration;
    }

    /// @notice The legitimate authorization for these terms, and for no other.
    /// @dev    The nonce is no longer an arbitrary value: it MUST equal
    ///         `termsHash(terms)`, failing which `open` reverts on `TermsMismatch`.
    ///         This is the heart of the latest fix — the EIP-3009 digest covers the
    ///         nonce, so constraining the nonce to hash the terms makes signing the
    ///         authorization amount to signing the terms. One single signature, and
    ///         the agent is committed to the beneficiary, the post-condition and the
    ///         duration, not merely to the amount.
    ///
    ///         We query `escrow.termsHash` instead of recomputing the `keccak256` on
    ///         the test side: reimplementing the formula would amount to testing a
    ///         copy against itself, and an encoding divergence would go unnoticed.
    ///         It is also what the client will do in production.
    function _authForTerms(WarrantEscrow escrow, MockUSDC token, address from, uint256 key, Terms memory t)
        internal
        view
        returns (WarrantEscrow.Authorization memory)
    {
        return _auth(token, address(escrow), from, key, t.bond, _termsNonce(escrow, t));
    }

    function _termsNonce(WarrantEscrow escrow, Terms memory t) internal pure returns (bytes32) {
        return escrow.termsHash(t.id, t.beneficiary, t.bond, t.conditionHash, t.actionHash, t.duration);
    }
}
