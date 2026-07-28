// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @title Handler de fuzzing stateful pour `WarrantEscrow`
/// @notice Toutes les transitions passent par ici. Le handler n'assère rien : il enregistre
///         des variables fantômes, et les assertions vivent dans les fonctions `invariant_`.
///         (Une assertion qui échoue dans un handler serait avalée par `fail_on_revert = false`.)
contract WarrantHandler is Test {
    WarrantEscrow public immutable escrow;
    MockUSDC public immutable usdc;

    address public immutable owner;
    address public immutable treasury;

    /// @dev Deux viviers **disjoints** : rotationner les rôles ne peut jamais les confondre (I10).
    address[3] public openerPool;
    address[3] public settlerPool;
    /// @dev Acteurs (agents / bénéficiaires). Exclut treasury, owner, opener, settler :
    ///      la comptabilité fantôme par adresse doit rester non ambiguë.
    address[4] public actors;

    bytes32[] public ids;

    // ── Variables fantômes ────────────────────────────────────────────────
    mapping(address => uint256) public ghostExpectedBalance; // I8 — conservation
    mapping(bytes32 => uint256) public ghostExits; // I2 — sorties de `Open`
    mapping(bytes32 => bytes32) public ghostConditionHash; // I4
    mapping(bytes32 => bytes32) public ghostActionHash; // I4
    mapping(bytes32 => uint256) public ghostBond; // I4
    mapping(bytes32 => address) public ghostAgent;
    mapping(bytes32 => uint8) public ghostFinalStatus; // I3 — 0 = encore Open
    uint256 public ghostFeesFromSlash; // I6 — doit rester 0
    uint256 public ghostFeesFromHonor;
    uint256 public ghostSumOpenBonds; // I1 — contrôle croisé de totalLocked

    uint256 public callsOpen;
    uint256 public callsHonor;
    uint256 public callsSlash;
    uint256 public callsReclaim;

    constructor(WarrantEscrow escrow_, MockUSDC usdc_, address owner_, address treasury_) {
        escrow = escrow_;
        usdc = usdc_;
        owner = owner_;
        treasury = treasury_;

        openerPool = [makeAddr("opener.0"), makeAddr("opener.1"), makeAddr("opener.2")];
        settlerPool = [makeAddr("settler.0"), makeAddr("settler.1"), makeAddr("settler.2")];
        actors = [makeAddr("agent.0"), makeAddr("agent.1"), makeAddr("agent.2"), makeAddr("agent.3")];
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i % actors.length];
    }

    function actorCount() external pure returns (uint256) {
        return 4;
    }

    // ── Transitions ───────────────────────────────────────────────────────

    /// @dev Le règlement x402 finance le contrat *avant* l'ouverture. On sous-finance
    ///      délibérément une fois sur quatre pour exercer le chemin `Underfunded`.
    function open(
        uint256 agentSeed,
        uint256 beneficiarySeed,
        uint256 bondSeed,
        uint256 durationSeed,
        uint256 fundSeed
    ) external {
        bytes32 id = keccak256(abi.encode("warrant", ids.length, bondSeed));
        address agent = actors[agentSeed % actors.length];
        address beneficiary = actors[beneficiarySeed % actors.length];
        uint256 bond = _bound(bondSeed, 1, 1_000_000e6);
        // Bornes volontairement débordantes : `BadDuration` doit être exercé aussi.
        uint64 duration = uint64(_bound(durationSeed, 0, uint256(escrow.MAX_DURATION()) + 1 days));

        uint256 funding = fundSeed % 4 == 0 ? bond / 2 : bond;
        if (funding > 0) usdc.mint(address(escrow), funding);

        bytes32 conditionHash = keccak256(abi.encode("condition", id));
        bytes32 actionHash = keccak256(abi.encode("action", id));

        vm.prank(escrow.opener());
        try escrow.open(
            id,
            agent,
            beneficiary,
            bond,
            conditionHash,
            actionHash,
            keccak256(abi.encode("funding", id)),
            duration
        ) {
            ids.push(id);
            ghostConditionHash[id] = conditionHash;
            ghostActionHash[id] = actionHash;
            ghostBond[id] = bond;
            ghostAgent[id] = agent;
            ghostSumOpenBonds += bond;
            ++callsOpen;
        } catch {}
    }

    function honor(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        WarrantEscrow.Warrant memory w = escrow.getWarrant(id);

        uint256 fee = (w.bond * escrow.feeBps()) / 10_000;
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(escrow.settler());
        try escrow.honor(id, keccak256(abi.encode("exec", id))) {
            ghostExpectedBalance[w.agent] += w.bond - fee;
            ghostExpectedBalance[treasury] += fee;
            ghostFeesFromHonor += usdc.balanceOf(treasury) - treasuryBefore;
            ghostSumOpenBonds -= w.bond;
            ghostExits[id] += 1;
            ghostFinalStatus[id] = uint8(WarrantEscrow.Status.Honored);
            ++callsHonor;
        } catch {}
    }

    function slash(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        WarrantEscrow.Warrant memory w = escrow.getWarrant(id);

        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(escrow.settler());
        try escrow.slash(id, keccak256(abi.encode("exec", id)), "post-condition violee") {
            ghostExpectedBalance[w.beneficiary] += w.bond;
            // I6 : la trésorerie ne doit bouger d'aucune unité sur une saisie.
            ghostFeesFromSlash += usdc.balanceOf(treasury) - treasuryBefore;
            ghostSumOpenBonds -= w.bond;
            ghostExits[id] += 1;
            ghostFinalStatus[id] = uint8(WarrantEscrow.Status.Slashed);
            ++callsSlash;
        } catch {}
    }

    /// @dev Sans permission : l'appelant est un tiers arbitraire.
    function reclaim(uint256 idSeed, uint256 callerSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        WarrantEscrow.Warrant memory w = escrow.getWarrant(id);

        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(address(uint160(uint256(keccak256(abi.encode("caller", callerSeed))))));
        try escrow.reclaim(id) {
            ghostExpectedBalance[w.agent] += w.bond; // remboursement intégral, sans frais
            ghostFeesFromSlash += usdc.balanceOf(treasury) - treasuryBefore;
            ghostSumOpenBonds -= w.bond;
            ghostExits[id] += 1;
            ghostFinalStatus[id] = uint8(WarrantEscrow.Status.Reclaimed);
            ++callsReclaim;
        } catch {}
    }

    /// @dev Fait avancer le temps pour que des mandats expirent réellement.
    function warp(uint256 seed) external {
        vm.warp(block.timestamp + _bound(seed, 1, 3 days));
    }

    function setFeeBps(uint256 seed) external {
        vm.prank(owner);
        try escrow.setFeeBps(uint16(_bound(seed, 0, 1_000))) {} catch {} // > MAX_FEE_BPS révèrte
    }

    /// @dev Rotation des rôles dans deux viviers disjoints : `opener != settler` par
    ///      construction, ce que l'invariant I10 revérifie à chaque pas.
    function rotateRoles(uint256 openerSeed, uint256 settlerSeed) external {
        vm.startPrank(owner);
        escrow.setOpener(openerPool[openerSeed % openerPool.length]);
        escrow.setSettler(settlerPool[settlerSeed % settlerPool.length]);
        vm.stopPrank();
    }

    /// @dev Dons non sollicités d'USDC : ne doivent jamais casser la comptabilité.
    function donate(uint256 seed) external {
        usdc.mint(address(escrow), _bound(seed, 1, 1_000e6));
    }
}

/// @title Invariants I1–I10 de `WarrantEscrow` en fuzzing stateful
contract WarrantEscrowInvariantTest is StdInvariant, Test {
    WarrantEscrow internal escrow;
    MockUSDC internal usdc;
    WarrantHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();

        vm.prank(owner);
        escrow = new WarrantEscrow(address(usdc), treasury, makeAddr("opener.0"), makeAddr("settler.0"), 250);

        handler = new WarrantHandler(escrow, usdc, owner, treasury);

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = WarrantHandler.open.selector;
        selectors[1] = WarrantHandler.honor.selector;
        selectors[2] = WarrantHandler.slash.selector;
        selectors[3] = WarrantHandler.reclaim.selector;
        selectors[4] = WarrantHandler.warp.selector;
        selectors[5] = WarrantHandler.setFeeBps.selector;
        selectors[6] = WarrantHandler.rotateRoles.selector;
        selectors[7] = WarrantHandler.donate.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));

        // Personne d'autre ne doit être appelé directement par le fuzzer.
        excludeContract(address(escrow));
        excludeContract(address(usdc));
    }

    /// @dev Compare le sélecteur d'erreur renvoyé par un appel bas niveau.
    function _assertRevertsWith(bytes memory err, bytes4 expected, string memory context) internal pure {
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 got = bytes32(err);
        assertEq(got, bytes32(expected), context);
    }

    // ── I1 ────────────────────────────────────────────────────────────────

    /// @notice I1 — `token.balanceOf(this) >= totalLocked` à tout instant.
    function invariant_I1_NeverPromisesMoreThanItHolds() public view {
        assertGe(usdc.balanceOf(address(escrow)), escrow.totalLocked(), "I1 viole : contrat insolvable");
    }

    /// @notice I1 (contrôle croisé) — `totalLocked` est exactement la somme des bonds `Open`.
    function invariant_I1_TotalLockedMatchesOpenBonds() public view {
        uint256 sum;
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            if (w.status == WarrantEscrow.Status.Open) sum += w.bond;
        }
        assertEq(escrow.totalLocked(), sum, "totalLocked derive de la somme des bonds ouverts");
        assertEq(handler.ghostSumOpenBonds(), sum, "comptabilite fantome coherente");
    }

    // ── I2 / I3 ───────────────────────────────────────────────────────────

    /// @notice I2 — un mandat quitte `Open` exactement une fois.
    function invariant_I2_LeavesOpenAtMostOnce() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            assertLe(handler.ghostExits(id), 1, "I2 viole : double sortie de Open");
        }
    }

    /// @notice I3 — depuis `Open`, seuls `Honored`, `Slashed` et `Reclaimed` sont atteignables,
    ///         et un statut final ne change plus jamais.
    function invariant_I3_ClosedStateMachine() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            uint8 status = uint8(w.status);

            // Un mandat enregistré n'est jamais revenu à `None`.
            assertTrue(status != uint8(WarrantEscrow.Status.None), "I3 viole : retour a None");

            uint8 recorded = handler.ghostFinalStatus(id);
            if (recorded == 0) {
                assertEq(status, uint8(WarrantEscrow.Status.Open), "I3 viole : sortie non tracee");
            } else {
                assertEq(status, recorded, "I3 viole : statut final mute");
                assertTrue(
                    status == uint8(WarrantEscrow.Status.Honored)
                        || status == uint8(WarrantEscrow.Status.Slashed)
                        || status == uint8(WarrantEscrow.Status.Reclaimed),
                    "I3 viole : etat hors machine"
                );
            }
        }
    }

    // ── I4 ────────────────────────────────────────────────────────────────

    /// @notice I4 — `conditionHash` et `actionHash` sont immuables après `open`.
    function invariant_I4_CommitmentIsImmutable() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            assertEq(w.conditionHash, handler.ghostConditionHash(id), "I4 viole : conditionHash reecrit");
            assertEq(w.actionHash, handler.ghostActionHash(id), "I4 viole : actionHash reecrit");
            assertEq(w.bond, handler.ghostBond(id), "I4 viole : bond reecrit");
            assertEq(w.agent, handler.ghostAgent(id), "I4 viole : agent reecrit");
        }
    }

    // ── I5 ────────────────────────────────────────────────────────────────

    /// @notice I5 — après `expiry`, `reclaim` réussit **toujours** pour un mandat `Open`,
    ///         quel que soit l'appelant, et rembourse l'intégralité du bond à l'agent.
    function invariant_I5_ReclaimAlwaysSucceedsAfterExpiry() public {
        uint256 snap = vm.snapshotState();
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            if (w.status != WarrantEscrow.Status.Open || block.timestamp <= w.expiry) continue;

            uint256 before = usdc.balanceOf(w.agent);
            vm.prank(address(0xBEEF)); // un tiers quelconque, sans aucun privilège
            escrow.reclaim(id);
            assertEq(usdc.balanceOf(w.agent) - before, w.bond, "I5 viole : remboursement partiel");
        }
        vm.revertToState(snap);
    }

    // ── I6 ────────────────────────────────────────────────────────────────

    /// @notice I6 — `slash` ne prélève aucun frais. La trésorerie n'a jamais bougé d'une
    ///         seule unité lors d'une saisie (ni lors d'un `reclaim`).
    function invariant_I6_SlashTakesNoFee() public view {
        assertEq(handler.ghostFeesFromSlash(), 0, "I6 viole : frais preleves sur une saisie");
        assertEq(
            usdc.balanceOf(treasury), handler.ghostFeesFromHonor(), "tresorerie alimentee par honor seul"
        );
    }

    // ── I7 ────────────────────────────────────────────────────────────────

    /// @notice I7 — `feeBps <= MAX_FEE_BPS` en permanence.
    function invariant_I7_FeeCapHolds() public view {
        assertLe(escrow.feeBps(), escrow.MAX_FEE_BPS(), "I7 viole : plafond de frais depasse");
    }

    // ── I8 ────────────────────────────────────────────────────────────────

    /// @notice I8 — conservation exacte : chaque adresse détient précisément ce que la
    ///         séquence de règlements lui a versé (`bond - bond·feeBps/10000` sur `honor`).
    function invariant_I8_Conservation() public view {
        uint256 distributed;
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actorAt(i);
            assertEq(
                usdc.balanceOf(actor), handler.ghostExpectedBalance(actor), "I8 viole : montant inattendu"
            );
            distributed += usdc.balanceOf(actor);
        }
        distributed += usdc.balanceOf(treasury);
        assertEq(
            usdc.totalSupply(),
            distributed + usdc.balanceOf(address(escrow)),
            "conservation globale de l'actif"
        );
    }

    // ── I9 ────────────────────────────────────────────────────────────────

    /// @notice I9 — passé `expiry`, `honor` et `slash` révertent. C'est ce qui rend I5 vrai
    ///         face à un settler **hostile** et pas seulement face à un settler passif.
    function invariant_I9_SettlementWindowClosesAtExpiry() public {
        uint256 snap = vm.snapshotState();
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            if (w.status != WarrantEscrow.Status.Open || block.timestamp <= w.expiry) continue;

            address settler = escrow.settler();

            vm.prank(settler);
            (bool okHonor, bytes memory errHonor) =
                address(escrow).call(abi.encodeCall(WarrantEscrow.honor, (id, bytes32(0))));
            assertFalse(okHonor, "I9 viole : honor apres expiry");
            _assertRevertsWith(errHonor, WarrantEscrow.Expired.selector, "I9 : mauvaise erreur sur honor");

            vm.prank(settler);
            (bool okSlash, bytes memory errSlash) =
                address(escrow).call(abi.encodeCall(WarrantEscrow.slash, (id, bytes32(0), string("hostile"))));
            assertFalse(okSlash, "I9 viole : slash apres expiry");
            _assertRevertsWith(errSlash, WarrantEscrow.Expired.selector, "I9 : mauvaise erreur sur slash");

            // ...et le remboursement sans permission passe dans le même bloc (front-run).
            vm.prank(address(0xBEEF));
            escrow.reclaim(id);
        }
        vm.revertToState(snap);
    }

    // ── I10 ───────────────────────────────────────────────────────────────

    /// @notice I10 — rôles distincts et strictement cloisonnés : le settler ne peut pas
    ///         ouvrir, l'opener ne peut pas régler, et l'owner ne peut faire ni l'un ni l'autre.
    function invariant_I10_RolesAreDistinctAndEnforced() public {
        address opener = escrow.opener();
        address settler = escrow.settler();
        assertTrue(opener != settler, "I10 viole : opener == settler");

        uint256 snap = vm.snapshotState();

        // Le settler ne peut pas ouvrir.
        vm.prank(settler);
        (bool ok, bytes memory err) = address(escrow)
            .call(
                abi.encodeCall(
                    WarrantEscrow.open,
                    (
                        keccak256("probe"),
                        address(1),
                        address(2),
                        1,
                        bytes32(0),
                        bytes32(0),
                        bytes32(0),
                        1 hours
                    )
                )
            );
        assertFalse(ok, "I10 viole : le settler a pu ouvrir");
        _assertRevertsWith(err, WarrantEscrow.NotOpener.selector, "I10 : mauvaise erreur sur open");

        // L'opener ne peut ni honorer ni saisir.
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            if (escrow.getWarrant(id).status != WarrantEscrow.Status.Open) continue;

            vm.prank(opener);
            (ok, err) = address(escrow).call(abi.encodeCall(WarrantEscrow.honor, (id, bytes32(0))));
            assertFalse(ok, "I10 viole : l'opener a pu honorer");
            _assertRevertsWith(err, WarrantEscrow.NotSettler.selector, "I10 : mauvaise erreur sur honor");

            vm.prank(opener);
            (ok, err) =
                address(escrow).call(abi.encodeCall(WarrantEscrow.slash, (id, bytes32(0), string("x"))));
            assertFalse(ok, "I10 viole : l'opener a pu saisir");
            _assertRevertsWith(err, WarrantEscrow.NotSettler.selector, "I10 : mauvaise erreur sur slash");
            break; // un mandat ouvert suffit à prouver le cloisonnement à ce pas
        }

        vm.revertToState(snap);
    }
}
