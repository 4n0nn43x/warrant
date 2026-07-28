// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @title Tests unitaires de `WarrantEscrow`
/// @dev Couvre le plan de tests de `06-contrat-escrow.md` § 5, y compris les cas dédiés à I9.
contract WarrantEscrowTest is Test {
    WarrantEscrow internal escrow;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal opener = makeAddr("opener"); // le Gateway
    address internal settler = makeAddr("settler"); // le Settler — clé distincte (I10)
    address internal agent = makeAddr("agent");
    address internal beneficiary = makeAddr("beneficiary");
    address internal stranger = makeAddr("stranger");

    uint16 internal constant FEE_BPS = 250; // 2,5 %
    uint256 internal constant BOND = 100e6; // 100 USDC
    uint64 internal constant DURATION = 1 hours;

    bytes32 internal constant ID = keccak256("warrant-1");
    bytes32 internal constant CONDITION_HASH = keccak256("conditionSpec");
    bytes32 internal constant ACTION_HASH = keccak256("actionSpec");
    bytes32 internal constant FUNDING_REF = keccak256("x402-tx");
    bytes32 internal constant EXEC_REF = keccak256("keeperhub-exec");

    event WarrantOpened(
        bytes32 indexed id,
        address indexed agent,
        address indexed beneficiary,
        uint256 bond,
        bytes32 conditionHash,
        bytes32 actionHash,
        bytes32 fundingRef,
        uint64 expiry
    );
    event WarrantHonored(bytes32 indexed id, bytes32 execRef, uint256 refunded, uint256 fee);
    event WarrantSlashed(bytes32 indexed id, bytes32 execRef, uint256 amount, string reason);
    event WarrantReclaimed(bytes32 indexed id, uint256 refunded);
    event OpenerChanged(address indexed previous, address indexed next);
    event SettlerChanged(address indexed previous, address indexed next);

    function setUp() public {
        vm.warp(1_700_000_000); // un timestamp réaliste : évite les bornes à 0
        usdc = new MockUSDC();
        vm.prank(owner);
        escrow = new WarrantEscrow(address(usdc), treasury, opener, settler, FEE_BPS);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /// @dev Simule le règlement x402 : les fonds arrivent sur le contrat *avant* `open`.
    function _fund(uint256 amount) internal {
        usdc.mint(address(escrow), amount);
    }

    function _open(bytes32 id, uint256 bond, uint64 duration) internal {
        vm.prank(opener);
        escrow.open(id, agent, beneficiary, bond, CONDITION_HASH, ACTION_HASH, FUNDING_REF, duration);
    }

    function _openFunded(bytes32 id, uint256 bond, uint64 duration) internal {
        _fund(bond);
        _open(id, bond, duration);
    }

    // ── Constructeur & état initial ───────────────────────────────────────

    function test_Constructor_SetsState() public view {
        assertEq(address(escrow.token()), address(usdc));
        assertEq(escrow.treasury(), treasury);
        assertEq(escrow.opener(), opener);
        assertEq(escrow.settler(), settler);
        assertEq(escrow.owner(), owner);
        assertEq(escrow.feeBps(), FEE_BPS);
        assertEq(escrow.totalLocked(), 0);
        assertEq(escrow.MAX_FEE_BPS(), 500);
        assertEq(escrow.MIN_DURATION(), 15 minutes);
        assertEq(escrow.MAX_DURATION(), 7 days);
    }

    function test_Constructor_RevertsOnFeeAboveCap() public {
        vm.expectRevert(WarrantEscrow.BadFee.selector);
        new WarrantEscrow(address(usdc), treasury, opener, settler, 501);
    }

    /// @dev Pas de fonction de retrait d'urgence — c'est délibéré. Même l'owner ne peut pas
    ///      extraire un centime : les fonds ne sortent que par honor, slash ou reclaim.
    function test_NoEmergencyWithdrawExists() public {
        _openFunded(ID, BOND, DURATION);

        string[6] memory signatures = [
            "emergencyWithdraw()",
            "emergencyWithdraw(uint256)",
            "withdraw(uint256)",
            "sweep(address,uint256)",
            "rescue(address,address,uint256)",
            "transferOwnershipAndDrain(address)"
        ];

        for (uint256 i; i < signatures.length; ++i) {
            vm.prank(owner);
            (bool ok,) = address(escrow).call(abi.encodeWithSignature(signatures[i], owner, BOND, owner));
            assertFalse(ok, "une fonction de retrait existe");
        }

        assertEq(usdc.balanceOf(address(escrow)), BOND);
        assertEq(usdc.balanceOf(owner), 0);
    }

    // ── open ──────────────────────────────────────────────────────────────

    function test_Open_Succeeds() public {
        _fund(BOND);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit WarrantOpened(
            ID,
            agent,
            beneficiary,
            BOND,
            CONDITION_HASH,
            ACTION_HASH,
            FUNDING_REF,
            uint64(block.timestamp) + DURATION
        );
        _open(ID, BOND, DURATION);

        WarrantEscrow.Warrant memory w = escrow.getWarrant(ID);
        assertEq(w.agent, agent);
        assertEq(w.beneficiary, beneficiary);
        assertEq(w.bond, BOND);
        assertEq(w.conditionHash, CONDITION_HASH);
        assertEq(w.actionHash, ACTION_HASH);
        assertEq(w.fundingRef, FUNDING_REF);
        assertEq(w.openedAt, uint64(block.timestamp));
        assertEq(w.expiry, uint64(block.timestamp) + DURATION);
        assertEq(uint8(w.status), uint8(WarrantEscrow.Status.Open));
        assertEq(escrow.totalLocked(), BOND);
    }

    /// @dev I10 — un tiers ne peut pas ouvrir.
    function test_Open_RevertsWhenNotOpener() public {
        _fund(BOND);
        vm.prank(stranger);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, agent, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
    }

    /// @dev I10 — les rôles sont disjoints : le settler ne peut pas ouvrir.
    function test_Open_RevertsWhenCallerIsSettler() public {
        _fund(BOND);
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, agent, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
    }

    /// @dev I10 — l'owner non plus (il rotationne les rôles, il ne les exerce pas).
    function test_Open_RevertsWhenCallerIsOwner() public {
        _fund(BOND);
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, agent, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
    }

    function test_Open_RevertsOnDuplicateId() public {
        _openFunded(ID, BOND, DURATION);
        _fund(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.AlreadyExists.selector);
        escrow.open(ID, agent, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
    }

    /// @dev Un id déjà réglé reste consommé : pas de recyclage d'identifiant.
    function test_Open_RevertsOnReuseOfSettledId() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        _fund(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.AlreadyExists.selector);
        escrow.open(ID, agent, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
    }

    function test_Open_RevertsOnZeroBond() public {
        _fund(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ZeroBond.selector);
        escrow.open(ID, agent, beneficiary, 0, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
    }

    function test_Open_RevertsWhenUnderfunded() public {
        _fund(BOND - 1);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.Underfunded.selector);
        escrow.open(ID, agent, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
    }

    /// @dev Le solde du contrat couvre le premier mandat mais pas la somme des deux :
    ///      `totalLocked` est cumulatif, l'opener ne peut pas réutiliser les mêmes fonds.
    function test_Open_RevertsWhenSecondWarrantReusesSameFunds() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.Underfunded.selector);
        escrow.open(
            keccak256("warrant-2"),
            agent,
            beneficiary,
            BOND,
            CONDITION_HASH,
            ACTION_HASH,
            FUNDING_REF,
            DURATION
        );
        assertEq(escrow.totalLocked(), BOND);
    }

    function test_Open_RevertsBelowMinDuration() public {
        _fund(BOND);
        uint64 tooShort = escrow.MIN_DURATION() - 1;
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BadDuration.selector);
        escrow.open(ID, agent, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, FUNDING_REF, tooShort);
    }

    function test_Open_RevertsAboveMaxDuration() public {
        _fund(BOND);
        uint64 tooLong = escrow.MAX_DURATION() + 1;
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BadDuration.selector);
        escrow.open(ID, agent, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, FUNDING_REF, tooLong);
    }

    function test_Open_AcceptsExactBounds() public {
        _fund(2 * BOND);
        _open(ID, BOND, escrow.MIN_DURATION());
        _open(keccak256("warrant-2"), BOND, escrow.MAX_DURATION());

        assertEq(escrow.getWarrant(ID).expiry, uint64(block.timestamp) + escrow.MIN_DURATION());
        assertEq(
            escrow.getWarrant(keccak256("warrant-2")).expiry, uint64(block.timestamp) + escrow.MAX_DURATION()
        );
    }

    // ── honor ─────────────────────────────────────────────────────────────

    /// @dev I8 — l'agent reçoit exactement bond − bond·feeBps/10000.
    function test_Honor_TransfersBondMinusFee() public {
        _openFunded(ID, BOND, DURATION);

        uint256 expectedFee = (BOND * FEE_BPS) / 10_000; // 2,5 USDC
        uint256 expectedRefund = BOND - expectedFee; // 97,5 USDC
        assertEq(expectedRefund, 97_500_000, "97,5 % de la caution");

        vm.expectEmit(true, false, false, true, address(escrow));
        emit WarrantHonored(ID, EXEC_REF, expectedRefund, expectedFee);
        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        assertEq(usdc.balanceOf(agent), expectedRefund);
        assertEq(usdc.balanceOf(treasury), expectedFee);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Honored));
    }

    function test_Honor_WithZeroFee_RefundsEverything() public {
        vm.prank(owner);
        escrow.setFeeBps(0);
        _openFunded(ID, BOND, DURATION);

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        assertEq(usdc.balanceOf(agent), BOND);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    /// @dev I10 — l'opener ne peut pas régler.
    function test_Honor_RevertsWhenCallerIsOpener() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.honor(ID, EXEC_REF);
    }

    function test_Honor_RevertsWhenNotSettler() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(stranger);
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.honor(ID, EXEC_REF);
    }

    /// @dev I2 — un mandat quitte `Open` exactement une fois.
    function test_Honor_ThenHonor_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.startPrank(settler);
        escrow.honor(ID, EXEC_REF);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.honor(ID, EXEC_REF);
        vm.stopPrank();
    }

    /// @dev I2 — pas de saisie après remboursement.
    function test_Honor_ThenSlash_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.startPrank(settler);
        escrow.honor(ID, EXEC_REF);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.slash(ID, EXEC_REF, "trop tard");
        vm.stopPrank();
    }

    function test_Honor_UnknownId_Reverts() public {
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.honor(keccak256("inconnu"), EXEC_REF);
    }

    // ── slash ─────────────────────────────────────────────────────────────

    /// @dev I6 — aucune commission sur une saisie.
    function test_Slash_TransfersFullBondNoFee() public {
        _openFunded(ID, BOND, DURATION);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit WarrantSlashed(ID, EXEC_REF, BOND, "post-condition violee");
        vm.prank(settler);
        escrow.slash(ID, EXEC_REF, "post-condition violee");

        assertEq(usdc.balanceOf(beneficiary), BOND, "integralite au beneficiaire");
        assertEq(usdc.balanceOf(treasury), 0, "aucun frais preleve (I6)");
        assertEq(usdc.balanceOf(agent), 0);
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Slashed));
    }

    /// @dev I6 — vrai quelle que soit la valeur de `feeBps`, y compris au plafond.
    function test_Slash_NoFeeEvenAtMaxFeeBps() public {
        uint16 maxFee = escrow.MAX_FEE_BPS();
        vm.prank(owner);
        escrow.setFeeBps(maxFee);
        _openFunded(ID, BOND, DURATION);

        vm.prank(settler);
        escrow.slash(ID, EXEC_REF, "violation");

        assertEq(usdc.balanceOf(beneficiary), BOND);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    /// @dev I10 — l'opener ne peut pas saisir.
    function test_Slash_RevertsWhenCallerIsOpener() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.slash(ID, EXEC_REF, "violation");
    }

    function test_Slash_RevertsWhenNotSettler() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(beneficiary); // même le bénéficiaire ne peut pas se servir
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.slash(ID, EXEC_REF, "violation");
    }

    function test_Slash_ThenHonor_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.startPrank(settler);
        escrow.slash(ID, EXEC_REF, "violation");
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.honor(ID, EXEC_REF);
        vm.stopPrank();
    }

    // ── reclaim ───────────────────────────────────────────────────────────

    function test_Reclaim_RevertsBeforeExpiry() public {
        _openFunded(ID, BOND, DURATION);
        vm.expectRevert(WarrantEscrow.NotExpired.selector);
        escrow.reclaim(ID);
    }

    /// @dev La borne de `reclaim` est le miroir exact de celle de `honor` : à `expiry`
    ///      pile, le règlement est encore ouvert et `reclaim` est encore fermé.
    function test_Reclaim_RevertsAtExactExpiry() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry);
        vm.expectRevert(WarrantEscrow.NotExpired.selector);
        escrow.reclaim(ID);
    }

    /// @dev I5 — n'importe qui peut débloquer, et l'agent est remboursé intégralement.
    function test_Reclaim_ByStrangerAfterExpiry_RefundsAgentInFull() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit WarrantReclaimed(ID, BOND);
        vm.prank(stranger);
        escrow.reclaim(ID);

        assertEq(usdc.balanceOf(agent), BOND, "remboursement integral, sans frais");
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(stranger), 0, "aucune prime au declencheur");
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Reclaimed));
    }

    function test_Reclaim_Twice_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);
        escrow.reclaim(ID);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.reclaim(ID);
    }

    function test_Reclaim_AfterHonor_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);
        vm.warp(block.timestamp + DURATION + 1);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.reclaim(ID);
    }

    // ── I9 : la fenêtre de règlement est close après `expiry` ─────────────

    /// @dev I9 — la borne est `>`, pas `>=` : à `expiry` exactement, `honor` passe encore.
    function test_I9_HonorAtExactExpiry_Succeeds() public {
        _openFunded(ID, BOND, DURATION);
        uint64 expiry = escrow.getWarrant(ID).expiry;

        vm.warp(expiry);
        assertEq(block.timestamp, expiry);
        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Honored));
        assertEq(usdc.balanceOf(agent), BOND - (BOND * FEE_BPS) / 10_000);
    }

    /// @dev I9 — la borne est `>`, pas `>=` : à `expiry` exactement, `slash` passe encore.
    function test_I9_SlashAtExactExpiry_Succeeds() public {
        _openFunded(ID, BOND, DURATION);
        uint64 expiry = escrow.getWarrant(ID).expiry;

        vm.warp(expiry);
        vm.prank(settler);
        escrow.slash(ID, EXEC_REF, "violation");

        assertEq(usdc.balanceOf(beneficiary), BOND);
    }

    /// @dev I9 — une seconde après, le pouvoir du settler est éteint.
    function test_I9_HonorAtExpiryPlusOne_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.honor(ID, EXEC_REF);
    }

    /// @dev I9 — idem pour la saisie.
    function test_I9_SlashAtExpiryPlusOne_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.slash(ID, EXEC_REF, "trop tard");
    }

    /// @dev I9 — même très longtemps après, rien ne rouvre la fenêtre.
    function test_I9_SettlerPowerIsPermanentlyExtinguished() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 365 days);
        vm.startPrank(settler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.honor(ID, EXEC_REF);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.slash(ID, EXEC_REF, "trop tard");
        vm.stopPrank();

        // Le mandat reste `Open` et récupérable par n'importe qui.
        escrow.reclaim(ID);
        assertEq(usdc.balanceOf(agent), BOND);
    }

    /// @dev I9 — rotationner le settler ne rouvre pas la fenêtre : la borne est temporelle,
    ///      pas liée à une identité. Un owner compromis ne peut pas la contourner.
    function test_I9_RotatingSettlerDoesNotReopenWindow() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);

        address newSettler = makeAddr("newSettler");
        vm.prank(owner);
        escrow.setSettler(newSettler);

        vm.prank(newSettler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.slash(ID, EXEC_REF, "trop tard");
    }

    /// @notice **Le test central de la révision** : scénario de front-running.
    ///         Mandat expiré ; le settler hostile et un tiers soumettent `slash` et `reclaim`
    ///         dans le **même bloc**, le `slash` étant miné en premier. Le `slash` révèrte,
    ///         le `reclaim` réussit, l'agent est remboursé intégralement.
    function test_I9_FrontRunScenario_SlashRevertsReclaimSucceeds() public {
        _openFunded(ID, BOND, DURATION);
        uint64 expiry = escrow.getWarrant(ID).expiry;

        // Un seul et même bloc : on fige timestamp et numéro de bloc.
        vm.warp(expiry + 1);
        vm.roll(block.number + 1);
        uint256 blockNumber = block.number;
        uint256 blockTimestamp = block.timestamp;

        // Transaction 1 du bloc : le settler front-run le reclaim qu'il voit en mempool.
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.slash(ID, EXEC_REF, "saisie hostile apres expiration");

        // Le front-run a échoué : le mandat est intact.
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Open));
        assertEq(escrow.totalLocked(), BOND);

        // Transaction 2 du même bloc : le reclaim sans permission passe.
        assertEq(block.number, blockNumber, "meme bloc");
        assertEq(block.timestamp, blockTimestamp, "meme bloc");
        vm.prank(stranger);
        escrow.reclaim(ID);

        assertEq(usdc.balanceOf(agent), BOND, "agent rembourse integralement");
        assertEq(usdc.balanceOf(beneficiary), 0, "rien pour le beneficiaire");
        assertEq(usdc.balanceOf(treasury), 0, "aucun frais");
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Reclaimed));
    }

    /// @dev I9 — l'ordre inverse dans le bloc ne change rien : après `reclaim`,
    ///      `slash` échoue sur `NotOpen` au lieu d'`Expired`. Les deux chemins sont fermés.
    function test_I9_FrontRunScenario_ReverseOrder() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);

        vm.prank(stranger);
        escrow.reclaim(ID);

        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.slash(ID, EXEC_REF, "saisie hostile");

        assertEq(usdc.balanceOf(agent), BOND);
    }

    /// @dev `MIN_DURATION` doit suffire à un cycle L1 complet : exécution + 12 confirmations
    ///      (~12 s par bloc, soit 144 s) doit laisser une marge de règlement strictement
    ///      positive avant `expiry`.
    function test_I9_MinDurationCoversFullL1Cycle() public {
        uint64 minDuration = escrow.MIN_DURATION();
        _openFunded(ID, BOND, minDuration);
        uint64 expiry = escrow.getWarrant(ID).expiry;

        uint256 executionDelay = 30; // soumission + inclusion de la transaction
        uint256 confirmations = 12; // R2 : 12 confirmations sur L1
        uint256 blockTime = 12;
        uint256 evaluation = 15; // lecture RPC + évaluation des vérificateurs
        uint256 elapsed = executionDelay + confirmations * blockTime + evaluation; // 189 s

        vm.warp(block.timestamp + elapsed);
        assertLt(block.timestamp, expiry, "marge de reglement strictement positive");
        assertGt(uint256(expiry) - block.timestamp, 0);
        assertEq(uint256(expiry) - block.timestamp, uint256(minDuration) - elapsed); // 711 s

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF); // le règlement passe encore largement
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Honored));
    }

    // ── Administration ────────────────────────────────────────────────────

    function test_SetFeeBps_RevertsAboveCap() public {
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.BadFee.selector);
        escrow.setFeeBps(501);
        assertEq(escrow.feeBps(), FEE_BPS);
    }

    function test_SetFeeBps_AcceptsExactCap() public {
        vm.prank(owner);
        escrow.setFeeBps(500);
        assertEq(escrow.feeBps(), 500);
    }

    function test_SetFeeBps_RevertsWhenNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(WarrantEscrow.NotOwner.selector);
        escrow.setFeeBps(100);
    }

    function test_SetOpener_OnlyOwner() public {
        address next = makeAddr("nextOpener");

        vm.prank(stranger);
        vm.expectRevert(WarrantEscrow.NotOwner.selector);
        escrow.setOpener(next);

        vm.expectEmit(true, true, false, false, address(escrow));
        emit OpenerChanged(opener, next);
        vm.prank(owner);
        escrow.setOpener(next);
        assertEq(escrow.opener(), next);

        // L'ancien opener n'a plus le droit d'ouvrir.
        _fund(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, agent, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
    }

    function test_SetSettler_OnlyOwner() public {
        address next = makeAddr("nextSettler");

        vm.prank(stranger);
        vm.expectRevert(WarrantEscrow.NotOwner.selector);
        escrow.setSettler(next);

        vm.expectEmit(true, true, false, false, address(escrow));
        emit SettlerChanged(settler, next);
        vm.prank(owner);
        escrow.setSettler(next);
        assertEq(escrow.settler(), next);

        _openFunded(ID, BOND, DURATION);
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.honor(ID, EXEC_REF);
    }

    /// @dev I4 — l'engagement est immuable : aucune fonction ne réécrit les hashes.
    function test_I4_HashesAreImmutable() public {
        _openFunded(ID, BOND, DURATION);
        WarrantEscrow.Warrant memory before = escrow.getWarrant(ID);

        vm.prank(owner);
        escrow.setFeeBps(500);
        vm.prank(owner);
        escrow.setSettler(makeAddr("nextSettler"));

        WarrantEscrow.Warrant memory afterState = escrow.getWarrant(ID);
        assertEq(afterState.conditionHash, before.conditionHash);
        assertEq(afterState.actionHash, before.actionHash);
        assertEq(afterState.fundingRef, before.fundingRef);
        assertEq(afterState.expiry, before.expiry);
        assertEq(afterState.bond, before.bond);
        assertEq(afterState.agent, before.agent);
        assertEq(afterState.beneficiary, before.beneficiary);
    }

    /// @dev I8 en fuzzing : conservation exacte sur toute la plage de bonds et de frais.
    function testFuzz_Honor_ConservesValue(uint256 bond, uint16 fee) public {
        bond = bound(bond, 1, 1e15); // jusqu'à 1 milliard d'USDC
        fee = uint16(bound(fee, 0, escrow.MAX_FEE_BPS()));

        vm.prank(owner);
        escrow.setFeeBps(fee);
        _openFunded(ID, bond, DURATION);

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        uint256 expectedFee = (bond * fee) / 10_000;
        assertEq(usdc.balanceOf(treasury), expectedFee);
        assertEq(usdc.balanceOf(agent), bond - expectedFee);
        assertEq(usdc.balanceOf(agent) + usdc.balanceOf(treasury), bond, "conservation");
        assertEq(escrow.totalLocked(), 0);
    }

    /// @dev I1 en fuzzing sur un mandat isolé : le solde couvre toujours l'engagement.
    function testFuzz_Open_NeverPromisesMoreThanItHolds(uint256 funded, uint256 bond) public {
        funded = bound(funded, 0, 1e18);
        bond = bound(bond, 1, 1e18);
        _fund(funded);

        vm.prank(opener);
        if (bond > funded) {
            vm.expectRevert(WarrantEscrow.Underfunded.selector);
            escrow.open(ID, agent, beneficiary, bond, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
            assertEq(escrow.totalLocked(), 0);
        } else {
            escrow.open(ID, agent, beneficiary, bond, CONDITION_HASH, ACTION_HASH, FUNDING_REF, DURATION);
            assertGe(usdc.balanceOf(address(escrow)), escrow.totalLocked());
        }
    }

    /// @dev I9 en fuzzing : sur toute la plage temporelle, la frontière est exactement `>`.
    function testFuzz_I9_Boundary(uint64 duration, uint64 elapsed) public {
        duration = uint64(bound(duration, escrow.MIN_DURATION(), escrow.MAX_DURATION()));
        elapsed = uint64(bound(elapsed, 0, uint256(duration) + 30 days));

        _openFunded(ID, BOND, duration);
        uint64 expiry = escrow.getWarrant(ID).expiry;
        vm.warp(uint256(expiry) - duration + elapsed);

        vm.prank(settler);
        if (block.timestamp > expiry) {
            vm.expectRevert(WarrantEscrow.Expired.selector);
            escrow.slash(ID, EXEC_REF, "violation");
            // ...et le remboursement sans permission est alors toujours ouvert (I5).
            escrow.reclaim(ID);
            assertEq(usdc.balanceOf(agent), BOND);
        } else {
            escrow.slash(ID, EXEC_REF, "violation");
            assertEq(usdc.balanceOf(beneficiary), BOND);
        }
    }
}
