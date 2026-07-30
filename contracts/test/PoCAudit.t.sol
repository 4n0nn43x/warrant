// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {AuthSigner} from "./helpers/AuthSigner.sol";

/// @title PoC des correctifs d'audit — chaque test prouve qu'une attaque ÉCHOUE
/// @notice Un test par correctif. Ce ne sont pas des tests unitaires : ce sont des
///         scénarios d'attaque, joués depuis le point de vue de l'attaquant, dont
///         on démontre qu'ils ne produisent plus rien. Chacun émet les chiffres qui
///         font foi — gain de l'attaquant, montant récupéré par la victime, solde
///         libre captable, immobilisation évitée — parce qu'un `expectRevert` seul
///         ne dit pas ce que l'attaquant a *gagné*.
/// @dev    Références : `audit/findings/01-i10-non-applique.md` et
///         `audit/findings/02-opener-autorite-de-retrait.md`.
contract PoCAuditTest is AuthSigner {
    WarrantEscrow internal escrow;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal beneficiary = makeAddr("beneficiary");

    /// @dev L'attaquant EST l'opener : le wallet KeeperHub, que
    ///      `docs/transactions.md` § 3 décrit comme partagé à l'échelle de
    ///      l'organisation. Il porte une clé, pour pouvoir tenter de signer
    ///      lui-même des autorisations.
    address internal opener;
    uint256 internal openerKey;

    address internal settler;
    address internal victim; // l'agent qui paie réellement la caution
    uint256 internal victimKey;
    address internal stranger = makeAddr("stranger");

    uint16 internal constant FEE_BPS = 250; // 2,5 %
    uint256 internal constant BOND = 100e6; // 100 USDC
    uint64 internal constant DURATION = 1 hours;

    bytes32 internal constant ID = keccak256("poc-warrant");
    bytes32 internal constant ID2 = keccak256("poc-warrant-2");
    bytes32 internal constant CONDITION_HASH = keccak256("conditionSpec");
    bytes32 internal constant ACTION_HASH = keccak256("actionSpec");
    bytes32 internal constant EXEC_REF = keccak256("exec");

    uint256 internal nonceSeq;

    function setUp() public {
        vm.warp(1_700_000_000);
        (opener, openerKey) = makeAddrAndKey("opener-hostile");
        settler = makeAddr("settler");
        (victim, victimKey) = makeAddrAndKey("victime");

        usdc = new MockUSDC();
        vm.prank(owner);
        escrow = new WarrantEscrow(address(usdc), treasury, opener, settler, FEE_BPS);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /// @dev Nonce arbitraire, pour les cas où le refus attendu tombe AVANT le
    ///      contrôle des termes et où la conformité du nonce est donc hors sujet.
    function _nextNonce() internal returns (bytes32) {
        return keccak256(abi.encode("nonce", ++nonceSeq));
    }

    function _terms(bytes32 id, address ben, uint256 bond, uint64 duration)
        internal
        pure
        returns (Terms memory)
    {
        return Terms({
            id: id,
            beneficiary: ben,
            bond: bond,
            conditionHash: CONDITION_HASH,
            actionHash: ACTION_HASH,
            duration: duration
        });
    }

    /// @dev Les termes standard, ceux que la victime accepte réellement.
    function _standardTerms() internal view returns (Terms memory) {
        return _terms(ID, beneficiary, BOND, DURATION);
    }

    /// @dev L'autorisation légitime de la victime pour ces termes-là.
    function _victimAuth(Terms memory t) internal view returns (WarrantEscrow.Authorization memory) {
        return _authForTerms(escrow, usdc, victim, victimKey, t);
    }

    /// @dev Le solde du contrat qui n'est adossé à aucun mandat ouvert. C'était la
    ///      borne exacte du vol décrit par la trouvaille 02 : « balanceOf(escrow) −
    ///      totalLocked à l'instant du open ». On la mesure dans chaque PoC.
    function _freeBalance() internal view returns (uint256) {
        return usdc.balanceOf(address(escrow)) - escrow.totalLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 1 — I10 : les deux rôles ne peuvent plus être une seule clé
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Trouvaille 01. I10 était déclaré dans la documentation, testé par une
    ///         tautologie, imposé uniquement par un script de déploiement que rien
    ///         n'oblige à utiliser. Il est maintenant une garde du contrat, aux
    ///         trois endroits où la configuration peut naître ou changer.
    function test_PoC1_I10_ConstructorAndBothRotationsRefuseMergedRoles() public {
        uint256 refusals;

        // (a) Naissance : le constructeur refuse la configuration fusionnée.
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        new WarrantEscrow(address(usdc), treasury, opener, opener, FEE_BPS);
        ++refusals;

        // (b) Rotation de l'opener vers le settler courant.
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        escrow.setOpener(settler);
        ++refusals;

        // (c) Rotation du settler vers l'opener courant.
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        escrow.setSettler(opener);
        ++refusals;

        // L'état n'a pas bougé d'un iota : aucune des trois voies n'a de succès partiel.
        assertEq(escrow.opener(), opener);
        assertEq(escrow.settler(), settler);
        assertTrue(escrow.opener() != escrow.settler());

        emit log_named_uint("PoC1 - tentatives de fusion refusees", refusals);
        emit log_named_uint("PoC1 - fusions reussies", 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 2 — l'autorité de retrait de l'opener (le PoC central)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Trouvaille 02, sévérité haute. Avant le correctif, l'opener nommait
    ///         librement l'`agent` — destinataire de `honor` et de `reclaim` — sans
    ///         aucun lien vérifié avec le payeur, et le contrôle de financement
    ///         était purement agrégé : il était satisfait par l'argent de
    ///         n'importe qui. Un opener seul, sans collusion et sans capital,
    ///         encaissait tout solde libre via `reclaim` après `MIN_DURATION`.
    ///
    ///         Ce PoC ferme les cinq voies, dans l'ordre où un attaquant les
    ///         essaierait, et mesure son gain à chaque étape.
    function test_PoC2_HostileOpenerCannotAppropriateAnyonesFunds() public {
        // La victime détient sa caution et signe une autorisation adossée à des
        // termes précis : c'est le contenu du payload x402 `exact`, que l'opener
        // voit passer par construction — il est le Gateway.
        usdc.mint(victim, BOND);
        Terms memory t = _standardTerms();
        WarrantEscrow.Authorization memory victimAuth = _victimAuth(t);

        // ── Voie 1 : forger une autorisation au nom de la victime.
        // L'attaquant connaît son adresse et les termes, mais pas sa clé.
        WarrantEscrow.Authorization memory forged = _authForTerms(escrow, usdc, victim, openerKey, t);
        vm.prank(opener);
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, forged);

        // ── Voie 2 : se déclarer soi-même agent.
        // Impossible à formuler : `agent` n'est plus un paramètre. Le seul moyen
        // d'être l'agent est de signer — donc de payer. L'attaquant signe, mais
        // n'a pas un centime : le token refuse de le débiter.
        WarrantEscrow.Authorization memory selfAuth = _authForTerms(escrow, usdc, opener, openerKey, t);
        assertEq(usdc.balanceOf(opener), 0, "l'attaquant n'apporte aucun capital");
        vm.prank(opener);
        vm.expectRevert(MockUSDC.InsufficientBalance.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, selfAuth);

        // ── Voie 3 : détourner l'autorisation légitime vers d'autres termes, en se
        // désignant bénéficiaire. C'était le résidu que le premier correctif
        // laissait ouvert : la signature prouvait qui payait, pas ce qui était
        // accepté. Le nonce hachant désormais les termes, la substitution est
        // détectée par le contrat.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, opener, BOND, CONDITION_HASH, ACTION_HASH, DURATION, victimAuth);

        // ── Voie 4 : se rabattre sur les termes signés, tels quels. L'ouverture
        // réussit — c'est le chemin normal — mais l'`agent` est la VICTIME, prouvée
        // par sa signature, et le bénéficiaire est celui qu'elle a accepté.
        // `slash` appartient au settler, une clé que I10 garantit distincte.
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, victimAuth);
        assertEq(escrow.getWarrant(ID).agent, victim, "l'agent est le signataire, pas l'opener");
        assertEq(escrow.getWarrant(ID).beneficiary, beneficiary, "le beneficiaire est celui signe");

        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.slash(ID, EXEC_REF, "auto-attribution");
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.honor(ID, EXEC_REF);

        // ── Voie 5 : attendre l'expiration et déclencher `reclaim`, qui reste sans
        // permission. C'était le coup de grâce de l'attaque d'origine. Le
        // remboursement part maintenant vers l'agent *prouvé* : la victime.
        vm.warp(escrow.getWarrant(ID).expiry + 1);
        vm.prank(opener);
        escrow.reclaim(ID);

        uint256 attackerGain = usdc.balanceOf(opener);
        uint256 victimRecovered = usdc.balanceOf(victim);

        emit log_named_uint("PoC2 - caution de la victime (uUSDC)", BOND);
        emit log_named_uint("PoC2 - gain de l'opener hostile (uUSDC)", attackerGain);
        emit log_named_uint("PoC2 - recupere par la victime (uUSDC)", victimRecovered);
        emit log_named_uint("PoC2 - solde libre captable (uUSDC)", _freeBalance());
        emit log_named_uint("PoC2 - voies d'attaque fermees", 5);

        assertEq(attackerGain, 0, "l'opener ne recupere rien");
        assertEq(victimRecovered, BOND, "la victime recupere l'integralite");
        assertEq(usdc.balanceOf(treasury), 0, "aucun frais sur un reclaim");
        assertEq(_freeBalance(), 0, "aucun solde libre a capter");
    }

    /// @notice Le second volet de la trouvaille 02 : la *fenêtre* de solde libre.
    ///         L'ancienne attaque avait pour borne `balanceOf(escrow) − totalLocked`
    ///         à l'instant du `open`, et cette quantité était non nulle par
    ///         construction — chaque règlement x402 transitait par le solde du
    ///         contrat avant son ouverture. Le financement étant devenu atomique,
    ///         cette quantité est identiquement nulle à chaque étape du cycle de
    ///         vie d'un mandat. La borne du vol est donc zéro, et pas seulement
    ///         « difficile à atteindre ».
    function test_PoC2b_NoFreeBalanceWindowExistsAnymore() public {
        assertEq(_freeBalance(), 0, "avant tout mandat");

        usdc.mint(victim, 2 * BOND);
        WarrantEscrow.Authorization memory a1 = _victimAuth(_standardTerms());
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, a1);
        assertEq(_freeBalance(), 0, "juste apres une ouverture");

        WarrantEscrow.Authorization memory a2 = _victimAuth(_terms(ID2, beneficiary, BOND, DURATION));
        vm.prank(opener);
        escrow.open(ID2, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, a2);
        assertEq(_freeBalance(), 0, "avec deux mandats concurrents");

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);
        assertEq(_freeBalance(), 0, "apres un reglement");

        vm.warp(escrow.getWarrant(ID2).expiry + 1);
        escrow.reclaim(ID2);
        assertEq(_freeBalance(), 0, "apres un remboursement");
        assertEq(usdc.balanceOf(address(escrow)), 0, "le contrat ne retient plus rien");

        emit log_named_uint("PoC2b - solde libre maximal observe (uUSDC)", 0);
        emit log_named_uint("PoC2b - borne du vol de la trouvaille 02 (uUSDC)", 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 3 — anti-rejeu, en trois couches
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Une autorisation ne finance qu'un seul mandat. Depuis que le nonce
    ///         vaut `termsHash(termes)`, `id` compris, la protection est passée
    ///         d'une couche à trois, et les deux premières sont dans le contrat :
    ///           (a) autres termes → `TermsMismatch` ;
    ///           (b) mêmes termes → `AlreadyExists`, l'identifiant est consommé ;
    ///           (c) et la couche historique du token mord toujours, ce que le
    ///               volet (c) démontre sur un SECOND escrow — le `nonce` EIP-3009
    ///               est global par autorisant, pas par destinataire.
    function test_PoC3_ReplayingTheSameAuthorizationReverts() public {
        // Solde volontairement DOUBLE de la caution : si un rejeu échouait par
        // manque de fonds, le PoC ne prouverait rien sur le rejeu lui-même.
        usdc.mint(victim, 2 * BOND);
        Terms memory t = _standardTerms();
        bytes32 nonce = _termsNonce(escrow, t);
        WarrantEscrow.Authorization memory auth = _victimAuth(t);

        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
        assertTrue(usdc.authorizationState(victim, nonce), "nonce consomme par le token");
        assertEq(escrow.getWarrant(ID).fundingRef, nonce, "fundingRef == nonce == termsHash");

        // (a) Couche « termes » : l'autorisation ne désigne pas ce mandat-là.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID2, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // (b) Couche « identifiant » : les termes correspondent, mais l'id est pris.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.AlreadyExists.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // (c) Couche « token ». `termsHash` est `pure` : un second escrow adossé au
        // même USDC dérive EXACTEMENT le même nonce pour les mêmes termes. Les deux
        // contrôles précédents y passent donc — et c'est le token qui refuse, parce
        // qu'un nonce EIP-3009 est unique par autorisant, toutes contreparties
        // confondues. Sans cette couche, le même engagement serait finançable une
        // fois par escrow déployé.
        vm.prank(owner);
        WarrantEscrow escrow2 = new WarrantEscrow(address(usdc), treasury, opener, settler, FEE_BPS);
        assertEq(escrow2.termsHash(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION), nonce);
        WarrantEscrow.Authorization memory auth2 = _authForTerms(escrow2, usdc, victim, victimKey, t);
        vm.prank(opener);
        vm.expectRevert(MockUSDC.AuthorizationUsed.selector);
        escrow2.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth2);

        emit log_named_uint("PoC3 - solde de la victime avant (uUSDC)", 2 * BOND);
        emit log_named_uint("PoC3 - debite une seule fois (uUSDC)", 2 * BOND - usdc.balanceOf(victim));
        emit log_named_uint("PoC3 - mandats finances par cette autorisation", 1);
        emit log_named_uint("PoC3 - couches de protection anti-rejeu", 3);
        assertEq(usdc.balanceOf(victim), BOND, "un seul debit");
        assertEq(escrow.totalLocked(), BOND, "un seul mandat");
        assertEq(escrow2.totalLocked(), 0, "rien sur le second escrow");
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 4 — anti-interception
    // ─────────────────────────────────────────────────────────────────────

    /// @notice `receiveWithAuthorization` et non `transferWithAuthorization` : la
    ///         variante `receive` impose `to == msg.sender`. Sans elle, n'importe
    ///         qui pourrait soumettre l'autorisation interceptée directement au
    ///         token — les fonds arriveraient bien sur l'escrow, mais le nonce
    ///         serait consommé et l'`open` légitime révèrterait. On aurait remplacé
    ///         un vol par un déni de service qui recrée le problème des fonds
    ///         orphelins : payés, sans mandat, sans recours.
    function test_PoC4_ThirdPartyCannotSubmitTheAuthorizationToTheToken() public {
        usdc.mint(victim, BOND);
        Terms memory t = _standardTerms();
        bytes32 nonce = _termsNonce(escrow, t);
        WarrantEscrow.Authorization memory auth = _victimAuth(t);

        // (a) Le tiers soumet l'autorisation telle quelle, `to` = l'escrow.
        // `to != msg.sender` : refusé avant tout examen de la signature.
        vm.prank(stranger);
        vm.expectRevert(MockUSDC.CallerMustBePayee.selector);
        usdc.receiveWithAuthorization(
            victim, address(escrow), BOND, VALID_AFTER, VALID_BEFORE, nonce, auth.v, auth.r, auth.s
        );

        // (b) Le tiers se met lui-même en `to` pour satisfaire ce contrôle. Le
        // digest change alors, et la signature de la victime ne le couvre plus.
        vm.prank(stranger);
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.receiveWithAuthorization(
            victim, stranger, BOND, VALID_AFTER, VALID_BEFORE, nonce, auth.v, auth.r, auth.s
        );

        // Le nonce est intact : l'autorisation légitime passe encore. C'est le
        // point qui distingue un vrai correctif d'un déni de service.
        assertFalse(usdc.authorizationState(victim, nonce), "nonce non consomme");
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        emit log_named_uint("PoC4 - interceptions reussies", 0);
        emit log_named_uint("PoC4 - detourne par le tiers (uUSDC)", usdc.balanceOf(stranger));
        emit log_named_uint("PoC4 - encaisse par l'escrow (uUSDC)", usdc.balanceOf(address(escrow)));
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(address(escrow)), BOND);
        assertEq(escrow.getWarrant(ID).agent, victim);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 5 — `beneficiary == treasury` refusé
    // ─────────────────────────────────────────────────────────────────────

    /// @notice I6 (« une saisie ne prélève aucun frais ») était une propriété des
    ///         chemins de code : `slash` n'appelait simplement pas la trésorerie.
    ///         Mais un opener pouvait désigner la trésorerie comme bénéficiaire, et
    ///         une saisie lui versait alors 100 % du bond — I6 restait vrai à la
    ///         lettre et faux dans son intention. La garde le rend vrai par
    ///         construction : l'état interdit devient inatteignable.
    /// @dev    L'autorisation est ici **conforme** à des termes qui nomment la
    ///         trésorerie : le seul motif de refus possible est donc bien
    ///         `BeneficiaryIsTreasury`, et non un nonce mal dérivé. La victime
    ///         elle-même ne peut pas consentir à cette configuration.
    function test_PoC5_BeneficiaryCannotBeTheTreasury() public {
        usdc.mint(victim, 2 * BOND);
        WarrantEscrow.Authorization memory toTreasury = _victimAuth(_terms(ID, treasury, BOND, DURATION));

        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BeneficiaryIsTreasury.selector);
        escrow.open(ID, treasury, BOND, CONDITION_HASH, ACTION_HASH, DURATION, toTreasury);

        // Contre-épreuve : avec un bénéficiaire régulier, tout le chemin fonctionne
        // et la trésorerie ne reçoit toujours rien sur une saisie.
        WarrantEscrow.Authorization memory regular = _victimAuth(_standardTerms());
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, regular);
        vm.prank(settler);
        escrow.slash(ID, EXEC_REF, "post-condition violee");

        emit log_named_uint("PoC5 - verse a la tresorerie sur saisie (uUSDC)", usdc.balanceOf(treasury));
        emit log_named_uint("PoC5 - verse au beneficiaire (uUSDC)", usdc.balanceOf(beneficiary));
        assertEq(usdc.balanceOf(treasury), 0, "I6 vrai par construction");
        assertEq(usdc.balanceOf(beneficiary), BOND);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 6 — frais figés à l'ouverture
    // ─────────────────────────────────────────────────────────────────────

    /// @notice L'owner pouvait doubler `feeBps` entre l'ouverture d'un mandat et son
    ///         règlement, et prélever le nouveau taux sur une caution déjà engagée.
    ///         L'agent s'engageait sur des conditions économiques que sa contrepartie
    ///         pouvait modifier unilatéralement après coup. `feeBpsAtOpen` les fige.
    function test_PoC6_FeeIsFrozenAtOpenTime() public {
        usdc.mint(victim, BOND);
        WarrantEscrow.Authorization memory auth = _victimAuth(_standardTerms());

        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
        assertEq(escrow.getWarrant(ID).feeBpsAtOpen, 250, "ouvert a 250 bps");

        // L'owner double le taux, au plafond, pendant que le mandat est ouvert.
        vm.prank(owner);
        escrow.setFeeBps(500);
        assertEq(escrow.feeBps(), 500, "taux courant double");

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        uint256 feeAt250 = (BOND * 250) / 10_000; // 2 500 000 = 2,5 USDC
        uint256 feeAt500 = (BOND * 500) / 10_000; // 5 000 000 = 5,0 USDC

        emit log_named_uint("PoC6 - taux a l'ouverture (bps)", 250);
        emit log_named_uint("PoC6 - taux courant au reglement (bps)", 500);
        emit log_named_uint("PoC6 - frais preleves (uUSDC)", usdc.balanceOf(treasury));
        emit log_named_uint("PoC6 - frais si le taux courant s'appliquait (uUSDC)", feeAt500);
        emit log_named_uint("PoC6 - rembourse a l'agent (uUSDC)", usdc.balanceOf(victim));
        emit log_named_uint("PoC6 - surfacturation evitee (uUSDC)", feeAt500 - feeAt250);

        assertEq(usdc.balanceOf(treasury), feeAt250, "frais au taux fige");
        assertEq(usdc.balanceOf(victim), BOND - feeAt250, "97,5 USDC, pas 95");
        assertEq(usdc.balanceOf(victim), 97_500_000);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 7 — `ValueMismatch`
    // ─────────────────────────────────────────────────────────────────────

    /// @notice `auth.value` doit valoir EXACTEMENT `bond`, dans les deux sens.
    ///         Un excédent serait irrécupérable — le contrat n'a aucune fonction de
    ///         balayage — et un déficit ferait porter au contrat un engagement
    ///         qu'il ne détient pas, cassant I1 dès que le token accepterait un
    ///         transfert partiel.
    /// @dev    Chaque autorisation est conforme à SES propres termes ; ce qui diverge
    ///         est le `bond` déclaré dans l'appel. `ValueMismatch` s'applique en
    ///         amont du contrôle des termes, on isole donc bien cette garde-là.
    function test_PoC7_ValueMustMatchBondExactly() public {
        usdc.mint(victim, 10 * BOND); // solde abondant : le refus ne vient pas de là

        // Sens 1 : l'autorisation porte plus que la caution déclarée. L'excédent
        // resterait bloqué à jamais sur le contrat.
        WarrantEscrow.Authorization memory tooMuch = _victimAuth(_terms(ID, beneficiary, BOND + 1, DURATION));
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ValueMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, tooMuch);

        // Sens 2 : l'autorisation porte moins que la caution déclarée. Le contrat
        // s'engagerait sur `BOND` en n'encaissant que `BOND - 1`.
        WarrantEscrow.Authorization memory tooLittle =
            _victimAuth(_terms(ID, beneficiary, BOND - 1, DURATION));
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ValueMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, tooLittle);

        // Le cas exact passe, et le financement est au centime près.
        WarrantEscrow.Authorization memory exact = _victimAuth(_standardTerms());
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, exact);

        emit log_named_uint("PoC7 - caution declaree (uUSDC)", BOND);
        emit log_named_uint("PoC7 - refuse a bond+1 (uUSDC)", BOND + 1);
        emit log_named_uint("PoC7 - refuse a bond-1 (uUSDC)", BOND - 1);
        emit log_named_uint("PoC7 - encaisse par l'escrow (uUSDC)", usdc.balanceOf(address(escrow)));
        emit log_named_uint("PoC7 - engage (totalLocked, uUSDC)", escrow.totalLocked());
        emit log_named_uint("PoC7 - excedent irrecuperable (uUSDC)", _freeBalance());

        assertEq(usdc.balanceOf(address(escrow)), BOND);
        assertEq(escrow.totalLocked(), BOND);
        assertEq(_freeBalance(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 8 — substitution de bénéficiaire (liaison des termes)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Le résidu que le premier correctif laissait ouvert. Le digest EIP-3009
    ///         ne couvre que `(from, to, value, validAfter, validBefore, nonce)` :
    ///         l'agent prouvait qu'il payait, sans rien dire de ce à quoi il
    ///         adossait son paiement. L'`opener` pouvait donc prendre une
    ///         autorisation destinée à un mandat et l'utiliser pour un autre, dont
    ///         il choisissait le bénéficiaire — un complice. Avec un `settler`
    ///         complice, `slash` immédiat versait 100 % du bond, sans frais : I10
    ///         ramenait l'attaque de une clé à deux, il ne la fermait pas.
    ///
    ///         Le nonce hachant maintenant les termes, `beneficiary` est couvert par
    ///         la signature de l'agent.
    function test_PoC8_OpenerCannotSubstituteTheBeneficiary() public {
        usdc.mint(victim, BOND);
        Terms memory agreed = _standardTerms(); // bénéficiaire accepté : `beneficiary`
        WarrantEscrow.Authorization memory auth = _victimAuth(agreed);
        address accomplice = makeAddr("complice-du-settler");

        // Substitution vers un complice.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, accomplice, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Substitution vers l'opener lui-même.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, opener, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Rien n'a bougé, et les termes acceptés restent ouvrables.
        assertEq(escrow.totalLocked(), 0, "aucun mandat detourne");
        assertEq(usdc.balanceOf(victim), BOND, "la victime n'a pas ete debitee");
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Et même avec un settler complice, la saisie ne peut aller qu'au
        // bénéficiaire signé : le montant détournable est nul.
        vm.prank(settler);
        escrow.slash(ID, EXEC_REF, "settler complice");

        emit log_named_uint("PoC8 - caution en jeu (uUSDC)", BOND);
        emit log_named_uint("PoC8 - substitutions de beneficiaire reussies", 0);
        emit log_named_uint("PoC8 - percu par le complice (uUSDC)", usdc.balanceOf(accomplice));
        emit log_named_uint("PoC8 - percu par l'opener (uUSDC)", usdc.balanceOf(opener));
        emit log_named_uint("PoC8 - percu par le beneficiaire signe (uUSDC)", usdc.balanceOf(beneficiary));
        emit log_named_uint("PoC8 - detournable meme avec collusion opener+settler (uUSDC)", 0);

        assertEq(usdc.balanceOf(accomplice), 0);
        assertEq(usdc.balanceOf(opener), 0);
        assertEq(usdc.balanceOf(beneficiary), BOND, "l'integralite au beneficiaire signe");
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 9 — substitution de durée (immobilisation sans consentement)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice L'autre exploitation du même résidu, et la plus insidieuse parce
    ///         qu'elle ne demande **aucune collusion et aucun capital** : l'`opener`
    ///         seul prenait une autorisation destinée à un mandat de `MIN_DURATION`
    ///         et ouvrait un mandat de `MAX_DURATION`. Rien n'était volé — `reclaim`
    ///         finissait par rembourser — mais la caution restait immobilisée
    ///         7 jours au lieu de 15 minutes, soit un déni de service sur le capital
    ///         de l'agent, gratuit pour l'attaquant et répétable à chaque paiement.
    function test_PoC9_OpenerCannotStretchTheLockupDuration() public {
        uint64 minDuration = escrow.MIN_DURATION(); // 900 s
        uint64 maxDuration = escrow.MAX_DURATION(); // 604 800 s
        usdc.mint(victim, BOND);

        // La victime n'accepte que la durée minimale.
        Terms memory agreed = _terms(ID, beneficiary, BOND, minDuration);
        WarrantEscrow.Authorization memory auth = _victimAuth(agreed);

        // L'opener tente l'étirement maximal.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, maxDuration, auth);

        // Et même un étirement d'une seule seconde est refusé : la borne n'est pas
        // « raisonnable », elle est exacte.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, minDuration + 1, auth);

        // La durée signée, elle, s'ouvre.
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, minDuration, auth);

        uint64 actualLockup = escrow.getWarrant(ID).expiry - escrow.getWarrant(ID).openedAt;

        emit log_named_uint("PoC9 - duree acceptee par l'agent (s)", minDuration);
        emit log_named_uint("PoC9 - duree effective du mandat (s)", actualLockup);
        emit log_named_uint("PoC9 - duree que l'opener voulait imposer (s)", maxDuration);
        emit log_named_uint("PoC9 - immobilisation evitee (s)", maxDuration - minDuration);
        emit log_named_uint("PoC9 - facteur d'etirement evite", maxDuration / minDuration);
        emit log_named_uint("PoC9 - capital immobilise en trop (uUSDC)", 0);

        assertEq(actualLockup, minDuration, "la duree est celle signee");
        assertEq(maxDuration / minDuration, 672, "7 jours contre 15 minutes");

        // Contrôle de bout en bout : la caution est bien récupérable au bout de
        // 15 minutes, et non de 7 jours.
        vm.warp(uint256(escrow.getWarrant(ID).expiry) + 1);
        escrow.reclaim(ID);
        assertEq(usdc.balanceOf(victim), BOND, "rembourse apres 900 s, pas 604 800");
    }
}
