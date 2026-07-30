// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WarrantEscrow} from "../../src/WarrantEscrow.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @title AuthSigner — fabrique d'autorisations EIP-3009 signées
/// @notice Depuis le correctif, `open` ne reçoit plus d'adresse d'agent : elle est
///         *déduite* de la signature. Toute la suite doit donc produire de vraies
///         signatures ECDSA, et les agents cessent d'être de simples `makeAddr`
///         pour devenir des comptes porteurs d'une clé (`makeAddrAndKey`).
/// @dev    Facteur commun aux trois fichiers de tests — unité, invariants et PoC
///         signent exactement le même digest. Le dupliquer trois fois reviendrait
///         à prendre le risque qu'une des copies dérive du domaine EIP-712 du
///         token : un test échouerait alors pour une raison sans rapport avec le
///         contrat audité, ce qui est le pire des faux positifs.
///
///         `from` et `key` sont volontairement des paramètres **indépendants** :
///         c'est ce qui permet aux PoC de fabriquer une autorisation *forgée*
///         (une adresse `from` qu'on prétend, une clé qui n'est pas la sienne) et
///         de prouver que le token la rejette.
abstract contract AuthSigner is Test {
    /// @dev Bornes temporelles délibérément larges par défaut. `validAfter = 0`
    ///      parce que le token exige `block.timestamp > validAfter` — une borne
    ///      stricte, qu'un `validAfter` égal à l'instant courant ferait échouer.
    ///      `validBefore` maximal parce que la suite warpe jusqu'à +365 jours et
    ///      qu'une autorisation périmée masquerait la propriété testée.
    uint256 internal constant VALID_AFTER = 0;
    uint256 internal constant VALID_BEFORE = type(uint256).max;

    /// @dev Reconstitue le digest EIP-712 de `ReceiveWithAuthorization` tel que
    ///      le token le recalculera. `to` est un paramètre et non `address(this)`
    ///      : c'est lui qui lie l'autorisation à l'escrow, et le PoC
    ///      anti-interception a besoin de le manipuler.
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

    /// @notice Autorisation à fenêtre temporelle explicite.
    /// @param from  l'adresse *déclarée* comme autorisante.
    /// @param key   la clé qui signe réellement. Si elle ne correspond pas à
    ///              `from`, l'autorisation est une contrefaçon et le token doit
    ///              révèrter sur `InvalidSignature`.
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

    /// @notice Cas courant : fenêtre ouverte, autorisation destinée à `to`, nonce
    ///         imposé par l'appelant. Réservé aux tests qui doivent produire un
    ///         nonce **non conforme** aux termes, donc rejeté par `TermsMismatch`.
    function _auth(MockUSDC token, address to, address from, uint256 key, uint256 value, bytes32 nonce)
        internal
        view
        returns (WarrantEscrow.Authorization memory)
    {
        return _authWindow(token, to, from, key, value, nonce, VALID_AFTER, VALID_BEFORE);
    }

    /// @notice Les termes d'un mandat, tels que `termsHash` les engage.
    /// @dev    Regroupés dans une struct pour une raison pratique et une raison de
    ///         fond. Pratique : six paramètres de plus dans chaque helper faisaient
    ///         sortir le handler d'invariants en « stack too deep ». De fond : ces
    ///         six valeurs ne forment plus une liste d'arguments mais **un seul
    ///         objet**, celui que l'agent signe. Les dissocier dans les tests
    ///         reviendrait à nier la propriété qu'on cherche à vérifier.
    struct Terms {
        bytes32 id;
        address beneficiary;
        uint256 bond;
        bytes32 conditionHash;
        bytes32 actionHash;
        uint64 duration;
    }

    /// @notice L'autorisation légitime pour ces termes-là, et pour aucun autre.
    /// @dev    Le nonce n'est plus un aléa : il DOIT valoir
    ///         `termsHash(termes)`, sans quoi `open` révèrte sur `TermsMismatch`.
    ///         C'est le cœur du dernier correctif — le digest EIP-3009 couvre le
    ///         nonce, donc contraindre le nonce à hacher les termes fait que signer
    ///         l'autorisation vaut signature des termes. Une seule signature, et
    ///         l'agent est engagé sur le bénéficiaire, la post-condition et la
    ///         durée, pas seulement sur le montant.
    ///
    ///         On interroge `escrow.termsHash` au lieu de recalculer le `keccak256`
    ///         côté test : réimplémenter la formule reviendrait à tester une copie
    ///         contre elle-même, et une divergence d'encodage passerait inaperçue.
    ///         C'est aussi ce que fera le client en production.
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
