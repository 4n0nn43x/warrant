// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {AuthSigner} from "./helpers/AuthSigner.sol";

/// @title Handler de fuzzing stateful pour `WarrantEscrow`
/// @notice Toutes les transitions passent par ici. Le handler n'assère rien : il enregistre
///         des variables fantômes, et les assertions vivent dans les fonctions `invariant_`.
///         (Une assertion qui échoue dans un handler serait avalée par `fail_on_revert = false`.)
/// @dev    Migration post-audit : le financement d'un mandat est devenu une
///         autorisation EIP-3009 signée. Les acteurs cessent donc d'être des
///         adresses inertes pour devenir des comptes porteurs de clés — sans clé,
///         le handler ne peut plus ouvrir un seul mandat et la campagne entière
///         tournerait à vide.
contract WarrantHandler is AuthSigner {
    WarrantEscrow public immutable escrow;
    MockUSDC public immutable usdc;

    address public immutable owner;
    address public immutable treasury;

    /// @dev Vivier COMMUN aux deux rôles — voir le constructeur.
    address[3] public openerPool;
    address[3] public settlerPool;
    /// @dev Acteurs (agents / bénéficiaires). Exclut treasury, owner, opener, settler :
    ///      la comptabilité fantôme par adresse doit rester non ambiguë.
    address[4] public actors;
    /// @dev Clés privées des acteurs, indexées comme `actors`. C'est ce qui permet
    ///      de produire l'autorisation EIP-3009 sans laquelle `open` ne passe plus.
    uint256[4] public actorKeys;

    bytes32[] public ids;

    /// @dev Compteur monotone. Sert à la fois d'unicité d'identifiant et d'unicité
    ///      de nonce EIP-3009 : le token refuse deux fois le même nonce pour un même
    ///      autorisant, et un nonce recyclé ferait révèrter tous les `open` suivants
    ///      de cet agent — la campagne testerait le vide sans que rien ne le signale.
    uint256 public authSeq;

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

    /// @dev Tentatives de détournement des termes, et celles qui ont ABOUTI. La
    ///      seconde doit rester à zéro. Sans ces deux compteurs,
    ///      `invariant_I4_FundingRefBindsTheTerms` serait le quatrième avatar du
    ///      piège de l'audit : le handler ne signant que des termes conformes, la
    ///      liaison serait vraie par construction du harnais et l'invariant
    ///      passerait même si l'on retirait la garde du contrat.
    uint256 public callsSubstitutionAttempted;
    uint256 public callsSubstitutionAccepted;

    constructor(WarrantEscrow escrow_, MockUSDC usdc_, address owner_, address treasury_) {
        escrow = escrow_;
        usdc = usdc_;
        owner = owner_;
        treasury = treasury_;

        // Vivier COMMUN, et c'est tout l'enjeu. Avec deux viviers disjoints —
        // ce qu'il y avait ici — le fuzzer ne pouvait PAS produire
        // `opener == settler`, et `assertTrue(opener != settler)` passait 16 384
        // fois sans jamais rien tester. L'invariant certifiait une propriété que
        // le harnais imposait lui-même, jamais le contrat.
        openerPool = [makeAddr("role.0"), makeAddr("role.1"), makeAddr("role.2")];
        settlerPool = [makeAddr("role.0"), makeAddr("role.1"), makeAddr("role.2")];

        for (uint256 i; i < actors.length; ++i) {
            (actors[i], actorKeys[i]) = makeAddrAndKey(string.concat("agent.", vm.toString(i)));
        }
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

    /// @dev L'ouverture porte désormais son propre financement : le handler crédite
    ///      l'AGENT, puis fait signer l'autorisation. On sous-finance délibérément
    ///      une fois sur quatre — le chemin d'échec n'est plus `Underfunded` (le
    ///      contrat ne constate plus un solde, il tire le paiement) mais le refus du
    ///      token faute de solde chez l'agent. Il faut continuer à l'exercer : c'est
    ///      la seule voie par laquelle une ouverture peut échouer *après* que tous
    ///      les contrôles du contrat ont été franchis.
    ///
    ///      Le découpage `_plan` / `_tryOpen` autour d'une struct `Terms` en mémoire
    ///      n'est pas cosmétique : avec les six composantes des termes, l'agent, sa
    ///      clé, le financement et l'autorisation signée, le compilateur sortait en
    ///      « stack too deep » sans `via_ir`.
    function open(
        uint256 agentSeed,
        uint256 beneficiarySeed,
        uint256 bondSeed,
        uint256 durationSeed,
        uint256 fundSeed
    ) external {
        uint256 ai = agentSeed % actors.length;
        _tryOpen(ai, _plan(ai, beneficiarySeed, bondSeed, durationSeed), fundSeed);
    }

    function _plan(uint256 ai, uint256 beneficiarySeed, uint256 bondSeed, uint256 durationSeed)
        internal
        returns (Terms memory t)
    {
        // `id` dérivé d'un compteur monotone : le nonce EIP-3009 valant désormais
        // `termsHash(termes)`, et `id` faisant partie des termes, c'est `id` seul
        // qui garantit l'unicité du nonce. Un `id` recyclé produirait un nonce déjà
        // consommé et ferait révèrter chaque ouverture — campagne vide.
        t.id = keccak256(abi.encode("warrant", ++authSeq));
        // Bénéficiaire OBLIGATOIREMENT distinct de l'agent : `open` révèrte
        // désormais sur `BadBeneficiary` si les deux coïncident. Tirer librement
        // dans le vivier ferait échouer une ouverture sur quatre pour une raison
        // sans intérêt et amputerait d'autant la profondeur utile de la campagne —
        // exactement le piège dans lequel `invariant_I10` était tombé, à l'envers.
        // `+ 1 + (seed % (n-1))` couvre les n−1 autres indices, jamais `ai`.
        t.beneficiary = actors[(ai + 1 + (beneficiarySeed % (actors.length - 1))) % actors.length];
        t.bond = _bound(bondSeed, 1, 1_000_000e6);
        t.conditionHash = keccak256(abi.encode("condition", t.id));
        t.actionHash = keccak256(abi.encode("action", t.id));
        // Bornes volontairement débordantes : `BadDuration` doit être exercé aussi.
        t.duration = uint64(_bound(durationSeed, 0, uint256(escrow.MAX_DURATION()) + 1 days));
    }

    function _tryOpen(uint256 ai, Terms memory t, uint256 fundSeed) internal {
        address agent = actors[ai];

        uint256 funding = fundSeed % 4 == 0 ? t.bond / 2 : t.bond;
        if (funding > 0) {
            usdc.mint(agent, funding);
            // Comptabilisé hors du `try` : si l'ouverture échoue, l'agent conserve
            // ces fonds, et I8 doit continuer à tomber juste.
            ghostExpectedBalance[agent] += funding;
        }

        // Nonce = `termsHash(termes)`, obtenu du contrat lui-même. Le recalculer ici
        // reviendrait à comparer une copie de la formule à elle-même.
        WarrantEscrow.Authorization memory auth = _authForTerms(escrow, usdc, agent, actorKeys[ai], t);

        // Une fois sur sept, l'`opener` joue le rôle de l'attaquant : il garde
        // l'autorisation signée pour `t.beneficiary` et ouvre le mandat au profit
        // d'un TIERS. C'est exactement le détournement que le dernier correctif
        // ferme, et c'est ce qui donne du mordant à
        // `invariant_I4_FundingRefBindsTheTerms` : si la garde disparaissait, ces
        // ouvertures aboutiraient et stockeraient une `fundingRef` qui ne hache pas
        // les termes réels du mandat. Le taux est modéré pour ne pas amputer la
        // profondeur utile de la campagne — ces appels sont voués à révèrter.
        address declared = t.beneficiary;
        if (fundSeed % 7 == 0) {
            declared = _otherActor(agent, t.beneficiary);
            ++callsSubstitutionAttempted;
        }

        vm.prank(escrow.opener());
        try escrow.open(t.id, declared, t.bond, t.conditionHash, t.actionHash, t.duration, auth) {
            ghostExpectedBalance[agent] -= t.bond; // la caution a réellement quitté l'agent
            ids.push(t.id);
            ghostConditionHash[t.id] = t.conditionHash;
            ghostActionHash[t.id] = t.actionHash;
            ghostBond[t.id] = t.bond;
            ghostAgent[t.id] = agent;
            ghostSumOpenBonds += t.bond;
            ++callsOpen;
            if (declared != t.beneficiary) ++callsSubstitutionAccepted;
        } catch {}
    }

    /// @dev Un acteur distinct de `agent` et de `signed` : le bénéficiaire substitué
    ///      doit franchir toutes les gardes situées AVANT le contrôle des termes
    ///      (non nul, ni la trésorerie, ni l'agent, ni le contrat), sinon le refus
    ///      viendrait d'ailleurs et ne prouverait rien sur la liaison.
    function _otherActor(address agent, address signed) internal view returns (address) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] != agent && actors[i] != signed) return actors[i];
        }
        return signed; // inatteignable avec quatre acteurs distincts
    }

    function honor(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        WarrantEscrow.Warrant memory w = escrow.getWarrant(id);

        // Le taux figé à l'ouverture, pas le taux courant : `setFeeBps` a pu bouger
        // entre-temps, et c'est précisément ce que le correctif neutralise.
        uint256 fee = (w.bond * w.feeBpsAtOpen) / 10_000;
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

    /// @dev Le fuzzer tire dans un vivier COMMUN, donc il tente régulièrement de
    ///      fusionner les deux rôles. Le contrat doit refuser : c'est la garde
    ///      `RolesMustDiffer`. On avale le revert pour que la campagne continue, et
    ///      `invariant_I10` vérifie ensuite que la fusion n'a pas eu lieu. Retirer
    ///      la garde du contrat doit faire ÉCHOUER `invariant_I10` — c'est le test
    ///      du test, et la raison d'être du vivier commun.
    function rotateRoles(uint256 openerSeed, uint256 settlerSeed) external {
        vm.startPrank(owner);
        try escrow.setOpener(openerPool[openerSeed % openerPool.length]) {} catch {}
        try escrow.setSettler(settlerPool[settlerSeed % settlerPool.length]) {} catch {}
        vm.stopPrank();
    }

    /// @dev Dons non sollicités d'USDC : ne doivent jamais casser la comptabilité.
    ///      Depuis que le financement est atomique et exact, c'est la SEULE source
    ///      d'excédent possible sur le contrat — donc le seul moyen de conserver à
    ///      I1 son sens d'inégalité (`>=`) plutôt qu'une égalité triviale.
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

    /// @dev Autorisation bidon, jamais valide. Elle suffit aux sondes qui doivent
    ///      révèrter AVANT l'appel au token : `NotOpener` est le tout premier
    ///      contrôle d'`open`, donc la signature n'est jamais atteinte. Fournir une
    ///      vraie signature ici masquerait un éventuel réordonnancement des gardes.
    function _dummyAuth() internal pure returns (WarrantEscrow.Authorization memory) {
        return WarrantEscrow.Authorization({
            from: address(1),
            value: 1,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: bytes32(0),
            v: 0,
            r: bytes32(0),
            s: bytes32(0)
        });
    }

    // ── Garde-fous du harnais ─────────────────────────────────────────────
    // La leçon de l'audit est qu'un invariant vert ne prouve rien si le harnais
    // ne peut pas atteindre l'état qu'il prétend interdire. Les deux tests qui
    // suivent sont déterministes — pas de fuzzing, pas de chance — et vérifient
    // que la campagne peut effectivement produire les situations qui comptent.

    /// @notice Le handler ouvre, honore, saisit et rembourse réellement. Si `open`
    ///         révèrtait systématiquement — par exemple parce qu'aucun agent ne
    ///         peut signer, ou parce que le bénéficiaire tiré est toujours l'agent —
    ///         les 16 384 appels d'une campagne s'exécuteraient sur un ensemble de
    ///         mandats vide et TOUS les invariants passeraient sans rien tester.
    function test_Handler_CampaignIsNotVacuous() public {
        for (uint256 i; i < 12; ++i) {
            handler.open(i, i, 1_000e6 * (i + 1), 1 hours, i + 1);
        }
        assertGt(handler.callsOpen(), 0, "le handler n'ouvre aucun mandat");
        assertEq(handler.idsLength(), handler.callsOpen(), "ids et compteur coherents");

        handler.honor(0);
        handler.slash(1);
        handler.warp(2 hours); // au-delà de la duree d'1 h : les mandats expirent
        handler.reclaim(2, 0xC0FFEE);

        emit log_named_uint("mandats ouverts", handler.callsOpen());
        emit log_named_uint("honores", handler.callsHonor());
        emit log_named_uint("saisis", handler.callsSlash());
        emit log_named_uint("rembourses apres expiry", handler.callsReclaim());

        assertGt(handler.callsHonor(), 0, "aucun honor atteint");
        assertGt(handler.callsSlash(), 0, "aucun slash atteint");
        assertGt(handler.callsReclaim(), 0, "aucun reclaim atteint");

        // Et le harnais tente réellement le détournement des termes, sans jamais y
        // parvenir. Les deux assertions vont ensemble : la première prouve que le
        // chemin d'attaque est emprunté, la seconde qu'il est fermé. Sans la
        // première, `invariant_I4_FundingRefBindsTheTerms` certifierait le harnais.
        emit log_named_uint("detournements tentes", handler.callsSubstitutionAttempted());
        emit log_named_uint("detournements acceptes", handler.callsSubstitutionAccepted());
        assertGt(handler.callsSubstitutionAttempted(), 0, "aucun detournement tente");
        assertEq(handler.callsSubstitutionAccepted(), 0, "un detournement a abouti");
    }

    /// @notice `rotateRoles` TENTE bien la fusion des deux rôles, et c'est le
    ///         contrat qui la refuse. C'est la condition sine qua non pour que
    ///         `invariant_I10` soit une assertion et non une tautologie : avec les
    ///         deux viviers disjoints d'avant l'audit, cette tentative était
    ///         impossible à formuler, et `assertTrue(opener != settler)` passait
    ///         16 384 fois en certifiant une propriété du harnais.
    function test_Handler_RotateRolesAttemptsTheMergeAndIsRefused() public {
        address candidate = handler.openerPool(0);
        assertEq(candidate, handler.settlerPool(0), "vivier commun : meme adresse des deux cotes");

        address settlerBefore = escrow.settler();
        // Seeds identiques : `setOpener(role.0)` puis `setSettler(role.0)`.
        handler.rotateRoles(0, 0);

        assertEq(escrow.opener(), candidate, "la premiere rotation a bien eu lieu");
        assertEq(escrow.settler(), settlerBefore, "la seconde a ete refusee par RolesMustDiffer");
        assertTrue(escrow.opener() != escrow.settler(), "I10 tient malgre la tentative de fusion");
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

    /// @notice I4 (volet ajouté par l'audit) — `agent` est celui qui a SIGNÉ, et
    ///         `fundingRef` est le nonce de son autorisation. Le lien entre le payeur
    ///         et le destinataire du remboursement n'est plus déclaratif : le token
    ///         a marqué ce nonce comme consommé par cette adresse-là, et par aucune
    ///         autre. C'est la propriété qui referme la faille 02.
    function invariant_I4_AgentIsTheProvenPayer() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            WarrantEscrow.Warrant memory w = escrow.getWarrant(handler.ids(i));
            assertTrue(
                usdc.authorizationState(w.agent, w.fundingRef),
                "I4 viole : mandat sans autorisation consommee par son agent"
            );
        }
    }

    /// @notice I4 (dernier volet) — **la liaison des termes, en version
    ///         permanente**. Tout mandat, à tout instant de la campagne, vérifie
    ///         `fundingRef == termsHash(ses propres termes)`. La signature de l'agent
    ///         couvre le nonce ; le nonce est ce hash ; donc l'agent a signé ces
    ///         termes-là — bénéficiaire, post-condition, action et durée comprises —
    ///         et pas un simple ordre de paiement que l'`opener` aurait ensuite
    ///         adossé à ce qu'il voulait.
    /// @dev    Entièrement reconstitué depuis l'état onchain, sans variable fantôme :
    ///         `duration` se relit comme `expiry - openedAt`. C'est délibéré — une
    ///         vérification qui n'a besoin de rien d'autre que du contrat est aussi
    ///         celle qu'un tiers peut refaire lui-même sur la chaîne.
    function invariant_I4_FundingRefBindsTheTerms() public view {
        // Le harnais TENTE le détournement une ouverture sur sept ; aucune ne doit
        // avoir abouti. Cette ligne est ce qui empêche l'invariant d'être une
        // tautologie du harnais plutôt qu'une propriété du contrat.
        assertEq(handler.callsSubstitutionAccepted(), 0, "detournement des termes accepte");

        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            assertEq(
                w.fundingRef,
                escrow.termsHash(
                    id, w.beneficiary, w.bond, w.conditionHash, w.actionHash, uint64(w.expiry - w.openedAt)
                ),
                "I4 viole : fundingRef ne hache pas les termes du mandat"
            );
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

    /// @notice I6 (volet ajouté par l'audit) — aucun mandat ne peut désigner la
    ///         trésorerie comme bénéficiaire, ni l'agent lui-même, ni le contrat.
    ///         I6 cesse d'être une propriété des seuls chemins de règlement pour
    ///         devenir une propriété de l'état : le cas est devenu inatteignable.
    function invariant_I6_NoDegenerateBeneficiary() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            WarrantEscrow.Warrant memory w = escrow.getWarrant(handler.ids(i));
            assertTrue(w.beneficiary != treasury, "I6 viole : beneficiaire = tresorerie");
            assertTrue(w.beneficiary != w.agent, "beneficiaire = agent");
            assertTrue(w.beneficiary != address(escrow), "beneficiaire = escrow");
        }
    }

    // ── I7 ────────────────────────────────────────────────────────────────

    /// @notice I7 — `feeBps <= MAX_FEE_BPS` en permanence, et le taux figé dans chaque
    ///         mandat respecte lui aussi le plafond (il en est une photographie).
    function invariant_I7_FeeCapHolds() public view {
        assertLe(escrow.feeBps(), escrow.MAX_FEE_BPS(), "I7 viole : plafond de frais depasse");
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            assertLe(
                escrow.getWarrant(handler.ids(i)).feeBpsAtOpen,
                escrow.MAX_FEE_BPS(),
                "I7 viole : taux fige au-dela du plafond"
            );
        }
    }

    // ── I8 ────────────────────────────────────────────────────────────────

    /// @notice I8 — conservation exacte : chaque adresse détient précisément ce que la
    ///         séquence de règlements lui a versé (`bond - bond·feeBpsAtOpen/10000` sur
    ///         `honor`), moins les cautions qu'elle a elle-même versées.
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
    /// @dev    `assertTrue(opener != settler)` n'est une assertion *réelle* que
    ///         parce que `rotateRoles` tire dans un vivier commun et tente donc la
    ///         fusion à chaque pas. Retirer `RolesMustDiffer` de
    ///         `setOpener`/`setSettler` doit faire échouer cet invariant : c'est
    ///         ainsi qu'on vérifie qu'il teste le contrat, et non le harnais.
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
                    (keccak256("probe"), address(2), 1, bytes32(0), bytes32(0), 1 hours, _dummyAuth())
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
