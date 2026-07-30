// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {AuthSigner} from "./helpers/AuthSigner.sol";

/// @title Tests unitaires de `WarrantEscrow`
/// @dev Couvre le plan de tests de `06-contrat-escrow.md` § 5, y compris les cas dédiés à I9.
///
///      Migration post-audit : `open` encaisse désormais la caution lui-même via
///      EIP-3009, et l'`agent` n'est plus un paramètre mais le résultat d'une
///      vérification de signature. Deux conséquences pour toute cette suite :
///        1. `agent` est un compte porteur d'une clé (`makeAddrAndKey`), pas un
///           `makeAddr` décoratif — sans clé, on ne peut plus rien ouvrir ;
///        2. le financement ne précède plus l'ouverture, il *est* l'ouverture.
///           Les fonds partent du solde de l'agent, pas d'un virement anonyme
///           préalable au contrat. `_fund` crédite donc l'agent, plus l'escrow.
contract WarrantEscrowTest is AuthSigner {
    WarrantEscrow internal escrow;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal opener = makeAddr("opener"); // le Gateway
    address internal settler = makeAddr("settler"); // le Settler — clé distincte (I10)
    address internal beneficiary = makeAddr("beneficiary");
    address internal stranger = makeAddr("stranger");

    /// @dev L'agent doit pouvoir SIGNER : c'est la signature, et non plus une
    ///      déclaration de l'opener, qui l'identifie comme payeur de la caution.
    address internal agent;
    uint256 internal agentKey;

    uint16 internal constant FEE_BPS = 250; // 2,5 %
    uint256 internal constant BOND = 100e6; // 100 USDC
    uint64 internal constant DURATION = 1 hours;

    bytes32 internal constant ID = keccak256("warrant-1");
    bytes32 internal constant ID2 = keccak256("warrant-2");
    bytes32 internal constant CONDITION_HASH = keccak256("conditionSpec");
    bytes32 internal constant ACTION_HASH = keccak256("actionSpec");
    bytes32 internal constant EXEC_REF = keccak256("keeperhub-exec");

    /// @dev Compteur de nonces, réservé aux autorisations **volontairement
    ///      non conformes**. Depuis le dernier correctif, le nonce d'une
    ///      autorisation légitime n'est plus libre : il vaut `termsHash(termes)`.
    ///      Un nonce tiré d'un compteur ne sert donc plus qu'à exercer les gardes
    ///      situées AVANT le contrôle des termes (`ZeroBond`, `BadDuration`,
    ///      `ZeroAddress`, les bénéficiaires dégénérés, `ValueMismatch`) — pour
    ///      celles-là, la conformité du nonce est hors sujet et un aléa évite de
    ///      laisser croire que le test dépend de la liaison.
    uint256 internal nonceSeq;

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
        (agent, agentKey) = makeAddrAndKey("agent");
        usdc = new MockUSDC();
        vm.prank(owner);
        escrow = new WarrantEscrow(address(usdc), treasury, opener, settler, FEE_BPS);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    function _nextNonce() internal returns (bytes32) {
        return keccak256(abi.encode("x402-nonce", ++nonceSeq));
    }

    /// @dev Crédite l'AGENT, et non plus le contrat : le règlement x402 n'arrive
    ///      plus par un virement anonyme préalable. C'est un changement de nature
    ///      du financement, pas un simple renommage de destinataire.
    function _fund(uint256 amount) internal {
        usdc.mint(agent, amount);
    }

    /// @dev Les termes standard de la suite, paramétrés par ce qui varie.
    function _terms(bytes32 id, uint256 bond, uint64 duration) internal view returns (Terms memory) {
        return Terms({
            id: id,
            beneficiary: beneficiary,
            bond: bond,
            conditionHash: CONDITION_HASH,
            actionHash: ACTION_HASH,
            duration: duration
        });
    }

    /// @dev Autorisation au nonce arbitraire : ne franchit PAS le contrôle des
    ///      termes. Réservée aux gardes qui s'appliquent en amont de celui-ci.
    function _looseAuth(uint256 value) internal returns (WarrantEscrow.Authorization memory) {
        return _auth(usdc, address(escrow), agent, agentKey, value, _nextNonce());
    }

    /// @dev Autorisation légitime : nonce dérivé des termes exacts du mandat.
    function _agentAuth(bytes32 id, uint256 bond, uint64 duration)
        internal
        view
        returns (WarrantEscrow.Authorization memory)
    {
        return _authForTerms(escrow, usdc, agent, agentKey, _terms(id, bond, duration));
    }

    /// @dev L'autorisation est construite AVANT le `vm.prank`, et jamais dans la
    ///      liste d'arguments d'`open` : `_authForTerms` interroge
    ///      `escrow.termsHash`, et cet appel consommerait le prank — `open`
    ///      partirait alors du mauvais appelant et révèrterait sur `NotOpener`.
    ///      C'est la deuxième fois que ce piège se déclenche dans cette suite.
    function _open(bytes32 id, uint256 bond, uint64 duration) internal returns (bytes32 nonce) {
        Terms memory t = _terms(id, bond, duration);
        nonce = _termsNonce(escrow, t);
        WarrantEscrow.Authorization memory auth = _authForTerms(escrow, usdc, agent, agentKey, t);
        vm.prank(opener);
        escrow.open(id, beneficiary, bond, CONDITION_HASH, ACTION_HASH, duration, auth);
    }

    function _openFunded(bytes32 id, uint256 bond, uint64 duration) internal returns (bytes32) {
        _fund(bond);
        return _open(id, bond, duration);
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

    /// @dev I10 — désormais imposé par le contrat lui-même, et plus seulement par
    ///      le script de déploiement, lequel restait contournable : rien n'oblige
    ///      un déployeur à passer par le script.
    function test_Constructor_RevertsWhenRolesAreMerged() public {
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        new WarrantEscrow(address(usdc), treasury, opener, opener, FEE_BPS);
    }

    /// @dev `token` et `treasury` étaient contrôlés par le seul script de
    ///      déploiement — la même asymétrie que celle reprochée à I10. Ils sont
    ///      maintenant contrôlés là où ça compte. `treasury == 0` avec des frais non
    ///      nuls aurait rendu tout `honor` impossible sur l'USDC réel, immobilisant
    ///      chaque caution jusqu'à son expiration.
    function test_Constructor_RevertsOnZeroTokenOrTreasury() public {
        vm.expectRevert(WarrantEscrow.ZeroAddress.selector);
        new WarrantEscrow(address(0), treasury, opener, settler, FEE_BPS);

        vm.expectRevert(WarrantEscrow.ZeroAddress.selector);
        new WarrantEscrow(address(usdc), address(0), opener, settler, FEE_BPS);
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
        Terms memory t = _terms(ID, BOND, DURATION);
        bytes32 nonce = _termsNonce(escrow, t);
        WarrantEscrow.Authorization memory auth = _authForTerms(escrow, usdc, agent, agentKey, t);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit WarrantOpened(
            ID,
            agent,
            beneficiary,
            BOND,
            CONDITION_HASH,
            ACTION_HASH,
            nonce,
            uint64(block.timestamp) + DURATION
        );
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        WarrantEscrow.Warrant memory w = escrow.getWarrant(ID);
        // `agent` n'a jamais été déclaré par personne : il sort de la signature.
        assertEq(w.agent, agent, "agent derive de la signature");
        assertEq(w.beneficiary, beneficiary);
        assertEq(w.bond, BOND);
        assertEq(w.conditionHash, CONDITION_HASH);
        assertEq(w.actionHash, ACTION_HASH);
        assertEq(w.fundingRef, nonce, "fundingRef == nonce EIP-3009");
        // Et ce nonce n'est pas un opaque : il hache les termes du mandat. La
        // `fundingRef` est donc vérifiable par n'importe qui à partir du seul état
        // onchain — c'est ce qui fait de la signature de l'agent un consentement
        // aux termes, et plus seulement un ordre de paiement.
        assertEq(
            w.fundingRef,
            escrow.termsHash(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION),
            "fundingRef == termsHash des termes du mandat"
        );
        assertEq(w.openedAt, uint64(block.timestamp));
        assertEq(w.expiry, uint64(block.timestamp) + DURATION);
        assertEq(w.feeBpsAtOpen, FEE_BPS, "taux fige a l'ouverture");
        assertEq(uint8(w.status), uint8(WarrantEscrow.Status.Open));
        assertEq(escrow.totalLocked(), BOND);

        // Financement atomique : les fonds ont quitté l'agent dans cette même
        // transaction, et le nonce est consommé côté token.
        assertEq(usdc.balanceOf(agent), 0, "la caution a quitte l'agent");
        assertEq(usdc.balanceOf(address(escrow)), BOND);
        assertTrue(usdc.authorizationState(agent, nonce), "nonce consomme");
    }

    /// @dev Le getter public généré rend maintenant DIX champs — `feeBpsAtOpen`
    ///      s'insère avant `status`. On décode le tuple entier : c'est ce que fait
    ///      l'indexeur, et une insertion silencieuse au milieu d'un tuple est
    ///      exactement le genre de changement qui casse un consommateur offchain
    ///      sans qu'aucun test de haut niveau ne s'en aperçoive.
    function test_Open_PublicGetterReturnsTenFields() public {
        bytes32 nonce = _openFunded(ID, BOND, DURATION);
        (
            address a,
            address b,
            uint256 bond,
            bytes32 conditionHash,
            bytes32 actionHash,
            bytes32 fundingRef,
            uint64 expiry,
            uint64 openedAt,
            uint16 feeBpsAtOpen,
            WarrantEscrow.Status status
        ) = escrow.warrants(ID);

        assertEq(a, agent);
        assertEq(b, beneficiary);
        assertEq(bond, BOND);
        assertEq(conditionHash, CONDITION_HASH);
        assertEq(actionHash, ACTION_HASH);
        assertEq(fundingRef, nonce);
        assertEq(expiry, uint64(block.timestamp) + DURATION);
        assertEq(openedAt, uint64(block.timestamp));
        assertEq(feeBpsAtOpen, FEE_BPS);
        assertEq(uint8(status), uint8(WarrantEscrow.Status.Open));
    }

    /// @dev I10 — un tiers ne peut pas ouvrir.
    function test_Open_RevertsWhenNotOpener() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(stranger);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev I10 — les rôles sont disjoints : le settler ne peut pas ouvrir.
    function test_Open_RevertsWhenCallerIsSettler() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev I10 — l'owner non plus (il rotationne les rôles, il ne les exerce pas).
    function test_Open_RevertsWhenCallerIsOwner() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Nonce neuf et solde suffisant : le seul motif de refus possible est
    ///      l'identifiant déjà pris. Sans cette précaution le test passerait au
    ///      vert sur `AuthorizationUsed` sans rien prouver sur `AlreadyExists`.
    function test_Open_RevertsOnDuplicateId() public {
        _openFunded(ID, BOND, DURATION);
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.AlreadyExists.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Un id déjà réglé reste consommé : pas de recyclage d'identifiant.
    function test_Open_RevertsOnReuseOfSettledId() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.AlreadyExists.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    function test_Open_RevertsOnZeroBond() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(0);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ZeroBond.selector);
        escrow.open(ID, beneficiary, 0, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Ex-`test_Open_RevertsWhenUnderfunded`, réécrit. Le sous-financement ne
    ///      se manifeste plus par `Underfunded()` : le contrat ne constate plus un
    ///      solde préexistant, il tire le paiement. C'est donc le TOKEN qui
    ///      arbitre, en refusant de débiter un agent insolvable ; `open` révèrte
    ///      avec lui et aucun mandat n'existe. L'intention d'origine (« un mandat
    ///      ne s'ouvre pas sans les fonds ») est conservée, la couche qui la fait
    ///      respecter change.
    function test_Open_RevertsWhenAgentCannotPay() public {
        _fund(BOND - 1);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(MockUSDC.InsufficientBalance.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        assertEq(escrow.totalLocked(), 0, "aucun engagement pris");
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.None));
        assertEq(usdc.balanceOf(agent), BOND - 1, "les fonds de l'agent n'ont pas bouge");
    }

    /// @dev Second volet : `Underfunded()` est devenu INATTEIGNABLE avec un token
    ///      honnête. Le solde du contrat est en permanence égal — et pas seulement
    ///      supérieur — à `totalLocked`, chaque ouverture encaissant exactement son
    ///      bond. La garde subsiste comme défense contre un token qui mentirait sur
    ///      son propre transfert ; on documente ici qu'aucune séquence d'appels
    ///      légitimes ne peut plus la déclencher.
    function test_Open_UnderfundedIsNowUnreachable() public {
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked());
        _openFunded(ID, BOND, DURATION);
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked(), "egalite, pas inegalite");
        _openFunded(ID2, 3 * BOND, DURATION);
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked());
        assertEq(escrow.totalLocked(), 4 * BOND);
    }

    /// @dev Ex-`test_Open_RevertsWhenSecondWarrantReusesSameFunds`, premier volet.
    ///      L'ancien scénario — deux mandats adossés au même virement — n'est plus
    ///      exprimable : il n'existe plus de virement séparé à réutiliser. Et depuis
    ///      que le nonce vaut `termsHash(termes)`, `id` compris, une autorisation
    ///      ne peut plus **par construction** désigner un autre mandat : elle est
    ///      refusée sur `TermsMismatch`, avant même que le token n'ait à constater
    ///      que son nonce est consommé. La protection est passée d'une couche à deux,
    ///      et la première est celle du contrat.
    function test_Open_SecondWarrantCannotReuseTheSameAuthorization() public {
        _fund(2 * BOND); // solde largement suffisant : le refus ne viendra pas de là
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);

        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Même autorisation, autre identifiant : les termes ne correspondent plus.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID2, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Même autorisation, même identifiant : l'identifiant est déjà consommé.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.AlreadyExists.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        assertEq(escrow.totalLocked(), BOND, "un seul mandat finance");
        assertEq(usdc.balanceOf(agent), BOND, "l'agent n'a ete debite qu'une fois");
    }

    /// @dev Second volet : chaque mandat exige son propre capital. Nonce neuf, mais
    ///      solde déjà épuisé — l'ouverture échoue côté token.
    function test_Open_SecondWarrantNeedsItsOwnFunds() public {
        _openFunded(ID, BOND, DURATION); // l'agent a versé tout son solde
        WarrantEscrow.Authorization memory auth = _agentAuth(ID2, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(MockUSDC.InsufficientBalance.selector);
        escrow.open(ID2, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
        assertEq(escrow.totalLocked(), BOND);
    }

    function test_Open_RevertsBelowMinDuration() public {
        _fund(BOND);
        uint64 tooShort = escrow.MIN_DURATION() - 1;
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BadDuration.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, tooShort, auth);
    }

    function test_Open_RevertsAboveMaxDuration() public {
        _fund(BOND);
        uint64 tooLong = escrow.MAX_DURATION() + 1;
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BadDuration.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, tooLong, auth);
    }

    function test_Open_AcceptsExactBounds() public {
        _fund(2 * BOND); // deux mandats, deux financements distincts
        _open(ID, BOND, escrow.MIN_DURATION());
        _open(ID2, BOND, escrow.MAX_DURATION());

        assertEq(escrow.getWarrant(ID).expiry, uint64(block.timestamp) + escrow.MIN_DURATION());
        assertEq(escrow.getWarrant(ID2).expiry, uint64(block.timestamp) + escrow.MAX_DURATION());
        assertEq(escrow.totalLocked(), 2 * BOND);
    }

    // ── open : les gardes ajoutées par l'audit ────────────────────────────

    function test_Open_RevertsOnZeroBeneficiary() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ZeroAddress.selector);
        escrow.open(ID, address(0), BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev `auth.from == 0` est intercepté AVANT l'appel au token. Le mock ne
    ///      reproduit pas le refus d'`address(0)` de FiatTokenV2_2 : c'est donc bien
    ///      la garde du contrat que ce test exerce, et non celle du token.
    function test_Open_RevertsOnZeroAuthFrom() public {
        WarrantEscrow.Authorization memory auth =
            _auth(usdc, address(escrow), address(0), agentKey, BOND, _nextNonce());
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ZeroAddress.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev I6 vrai par construction : une saisie ne peut pas alimenter la trésorerie.
    function test_Open_RevertsWhenBeneficiaryIsTreasury() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BeneficiaryIsTreasury.selector);
        escrow.open(ID, treasury, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Bénéficiaire dégénéré : une saisie rembourserait le fautif, et la
    ///      caution cesserait d'être une caution.
    function test_Open_RevertsWhenBeneficiaryIsAgent() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BadBeneficiary.selector);
        escrow.open(ID, agent, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Bénéficiaire dégénéré : la caution sortirait du passif sans sortir du
    ///      contrat, devenant un excédent irrécupérable (aucun sweep n'existe).
    function test_Open_RevertsWhenBeneficiaryIsEscrow() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BadBeneficiary.selector);
        escrow.open(ID, address(escrow), BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Les deux sens du décalage. Un excédent est aussi grave qu'un déficit :
    ///      il serait immobilisé pour toujours.
    function test_Open_RevertsOnValueMismatch() public {
        _fund(4 * BOND);

        WarrantEscrow.Authorization memory tooMuch = _looseAuth(BOND + 1);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ValueMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, tooMuch);

        WarrantEscrow.Authorization memory tooLittle = _looseAuth(BOND - 1);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ValueMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, tooLittle);

        assertEq(escrow.totalLocked(), 0);
    }

    /// @dev Le nonce doit hacher les termes. Un nonce arbitraire — y compris
    ///      parfaitement signé par l'agent — est refusé : sans quoi l'agent
    ///      signerait un ordre de paiement sans savoir à quoi il l'adosse.
    function test_Open_RevertsOnArbitraryNonce() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
        assertEq(escrow.totalLocked(), 0);
    }

    /// @dev Les six composantes des termes, une par une. Chaque champ que l'`opener`
    ///      pourrait vouloir substituer après coup est couvert par le nonce signé,
    ///      donc verrouillé. C'est le test qui vaut le plus cher : il énumère
    ///      exhaustivement la surface de détournement.
    function test_Open_RevertsWhenAnyTermIsSubstituted() public {
        _fund(BOND);
        Terms memory t = _terms(ID, BOND, DURATION);
        WarrantEscrow.Authorization memory auth = _authForTerms(escrow, usdc, agent, agentKey, t);
        address other = makeAddr("autre-beneficiaire");
        // Lu maintenant : sous `vm.expectRevert`, c'est le PROCHAIN appel qui est
        // surveillé — et l'évaluation d'un argument est un appel. `MAX_DURATION()`
        // dans la liste d'arguments capterait l'attente et ne révèrterait pas.
        uint64 maxDuration = escrow.MAX_DURATION();

        // (1) autre identifiant
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID2, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // (2) autre bénéficiaire — la substitution la plus rentable pour l'opener
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, other, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // (3) autre post-condition : l'agent serait jugé sur un critère qu'il
        //     n'a jamais accepté
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, keccak256("autre-condition"), ACTION_HASH, DURATION, auth);

        // (4) autre action
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, keccak256("autre-action"), DURATION, auth);

        // (5) autre durée : immobilisation prolongée sans consentement
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, maxDuration, auth);

        // (6) le montant est déjà couvert par `ValueMismatch`, qui s'applique en
        //     amont : `bond` différent de `auth.value` est refusé avant les termes.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ValueMismatch.selector);
        escrow.open(ID, beneficiary, BOND + 1, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Rien n'a été ouvert, et les termes d'origine restent honorables.
        assertEq(escrow.totalLocked(), 0, "aucune substitution n'a abouti");
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
        assertEq(escrow.totalLocked(), BOND, "les termes signes, eux, passent");
    }

    /// @dev La signature est le seul lien entre `auth.from` et le paiement. Une
    ///      autorisation dont la clé ne correspond pas à `from` est rejetée par le
    ///      token : c'est ce qui interdit à quiconque de *désigner* un agent.
    function test_Open_RevertsOnForgedSignature() public {
        _fund(BOND);
        (, uint256 wrongKey) = makeAddrAndKey("pas-l-agent");
        // Termes parfaitement conformes — seule la clé est la mauvaise. Le contrôle
        // des termes passe donc, et c'est bien la vérification de signature du token
        // qui rejette : on isole exactement la propriété visée.
        WarrantEscrow.Authorization memory forged =
            _authForTerms(escrow, usdc, agent, wrongKey, _terms(ID, BOND, DURATION));
        vm.prank(opener);
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, forged);
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

    /// @dev L'ordre des deux transferts a été inversé par le correctif : l'agent
    ///      d'abord, la trésorerie ensuite. `totalLocked` est déjà décrémenté du
    ///      bond ENTIER avant les transferts ; payer la trésorerie en premier
    ///      laissait un intervalle où le solde du contrat excédait son passif
    ///      déclaré. On vérifie donc l'ordre réel des événements `Transfer`, et non
    ///      les soldes finaux — identiques dans les deux ordres, ils ne prouvent
    ///      rien.
    function test_Honor_PaysAgentBeforeTreasury() public {
        _openFunded(ID, BOND, DURATION);

        vm.recordLogs();
        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        address[] memory recipients = new address[](2);
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(usdc) || logs[i].topics[0] != transferTopic) continue;
            if (seen < 2) recipients[seen] = address(uint160(uint256(logs[i].topics[2])));
            ++seen;
        }

        assertEq(seen, 2, "exactement deux transferts");
        assertEq(recipients[0], agent, "l'agent est paye en premier");
        assertEq(recipients[1], treasury, "la tresorerie ensuite");
    }

    /// @dev Le taux est figé à l'ouverture : changer `feeBps` après coup ne modifie
    ///      plus les conditions économiques d'un mandat déjà engagé.
    function test_Honor_UsesFeeFrozenAtOpen() public {
        _openFunded(ID, BOND, DURATION);
        // `MAX_FEE_BPS()` est lu AVANT le prank : évalué en argument, il
        // consommerait le `vm.prank` et `setFeeBps` partirait du mauvais appelant.
        uint16 maxFee = escrow.MAX_FEE_BPS();
        vm.prank(owner);
        escrow.setFeeBps(maxFee); // 250 → 500 bps

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        uint256 feeAtOpen = (BOND * FEE_BPS) / 10_000; // 2,5 USDC
        assertEq(usdc.balanceOf(treasury), feeAtOpen, "frais au taux de l'ouverture");
        assertEq(usdc.balanceOf(agent), BOND - feeAtOpen);
        assertEq(escrow.feeBps(), 500, "le taux courant a bien change");
        assertEq(escrow.getWarrant(ID).feeBpsAtOpen, FEE_BPS, "le taux du mandat, lui, est fige");
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
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
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

    /// @dev I10 — la rotation ne peut plus fusionner les deux rôles. Sans cette
    ///      garde, l'owner reconstituait par rotation exactement la configuration
    ///      que le constructeur interdit.
    function test_SetOpener_RevertsWhenItWouldMergeRoles() public {
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        escrow.setOpener(settler);
        assertEq(escrow.opener(), opener, "rotation refusee, etat inchange");
    }

    function test_SetSettler_RevertsWhenItWouldMergeRoles() public {
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        escrow.setSettler(opener);
        assertEq(escrow.settler(), settler, "rotation refusee, etat inchange");
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
        // Le taux figé fait désormais partie de l'engagement immuable.
        assertEq(afterState.feeBpsAtOpen, before.feeBpsAtOpen);
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

    /// @dev I1 en fuzzing. La propriété est la même — le contrat ne promet jamais
    ///      plus qu'il ne détient — mais le mécanisme a changé : le sous-financement
    ///      est arbitré par le token, et en cas de succès le solde est exactement
    ///      égal à `totalLocked`, plus seulement supérieur ou égal.
    function testFuzz_Open_NeverPromisesMoreThanItHolds(uint256 funded, uint256 bond) public {
        funded = bound(funded, 0, 1e18);
        bond = bound(bond, 1, 1e18);
        _fund(funded);

        WarrantEscrow.Authorization memory auth = _agentAuth(ID, bond, DURATION);
        vm.prank(opener);
        if (bond > funded) {
            vm.expectRevert(MockUSDC.InsufficientBalance.selector);
            escrow.open(ID, beneficiary, bond, CONDITION_HASH, ACTION_HASH, DURATION, auth);
            assertEq(escrow.totalLocked(), 0);
            assertEq(usdc.balanceOf(address(escrow)), 0);
        } else {
            escrow.open(ID, beneficiary, bond, CONDITION_HASH, ACTION_HASH, DURATION, auth);
            assertGe(usdc.balanceOf(address(escrow)), escrow.totalLocked());
            assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked(), "financement exact");
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
