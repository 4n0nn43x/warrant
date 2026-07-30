// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Le sous-ensemble d'EIP-3009 dont dépend le financement d'un mandat.
/// @dev    `receiveWithAuthorization` et non `transferWithAuthorization` : la
///         variante `receive` impose `to == msg.sender`. Sans elle, n'importe
///         qui pourrait intercepter l'autorisation signée et la soumettre
///         directement au token — les fonds arriveraient bien ici, mais le
///         `nonce` serait consommé et l'`open` légitime révèrterait. On aurait
///         remplacé un vol par un déni de service qui recrée le problème des
///         fonds orphelins.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title WarrantEscrow — cautions pour actions d'agents exécutées via KeeperHub
/// @notice Un mandat lie une caution à une post-condition onchain engagée avant exécution.
/// @dev    Contrat unique, sans gouvernance, sans proxy, sans fonction de retrait d'urgence.
///         Les fonds ne peuvent sortir que par `honor`, `slash` ou `reclaim`.
contract WarrantEscrow {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Honored,
        Slashed,
        Reclaimed
    }

    /// @notice Une autorisation EIP-3009 signée par l'agent, telle que la
    ///         transporte déjà le schéma `exact` de x402.
    struct Authorization {
        address from; // l'agent — PROUVÉ par la signature, jamais déclaré
        uint256 value; // doit valoir exactement `bond`
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce; // unicité garantie par le token lui-même
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Warrant {
        address agent; // payeur de la caution, destinataire du remboursement
        address beneficiary; // destinataire en cas de saisie
        uint256 bond; // montant en unités atomiques USDC
        bytes32 conditionHash; // keccak256(JCS(conditionSpec)) — engagement immuable
        bytes32 actionHash; // keccak256(JCS(actionSpec))
        bytes32 fundingRef; // hash de la tx x402 qui a financé la caution
        uint64 expiry; // au-delà : honor/slash fermés, reclaim ouvert à tous
        uint64 openedAt;
        uint16 feeBpsAtOpen; // figé ici : les conditions économiques ne bougent plus
        Status status;
    }

    IERC20 public immutable token;
    address public immutable treasury; // reçoit les frais
    address public opener; // seul autorisé à open — le Gateway
    address public settler; // seul autorisé à honor/slash — le Settler
    address public owner; // peut rotationner opener et settler
    uint16 public feeBps; // frais prélevés au remboursement, ≤ MAX_FEE_BPS

    uint256 public totalLocked; // somme des bonds en statut Open

    uint16 public constant MAX_FEE_BPS = 500; // 5 % — plafond en dur
    uint64 public constant MIN_DURATION = 15 minutes; // doit couvrir exécution + confirmations
    uint64 public constant MAX_DURATION = 7 days;

    mapping(bytes32 => Warrant) public warrants;

    // ── Events ────────────────────────────────────────────────────────────
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
    event SettlerChanged(address indexed previous, address indexed next);
    event OpenerChanged(address indexed previous, address indexed next);
    event FeeBpsChanged(uint16 previous, uint16 next);

    // ── Errors ────────────────────────────────────────────────────────────
    error NotOpener();
    error NotSettler();
    error NotOwner();
    error AlreadyExists();
    error NotOpen();
    error NotExpired();
    error Expired();
    error BadDuration();
    error BadFee();
    error ZeroBond();
    error Underfunded();
    error RolesMustDiffer();
    error ZeroAddress();
    error BeneficiaryIsTreasury();
    error BadBeneficiary();
    error ValueMismatch();
    error TermsMismatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param token_    USDC natif de la chaîne cible — figé, `immutable`.
    /// @param treasury_ destinataire des frais prélevés sur les mandats honorés.
    /// @param opener_   le Gateway : seule adresse autorisée à ouvrir un mandat.
    /// @param settler_  le Settler : seule adresse autorisée à honorer ou saisir.
    /// @param feeBps_   frais initiaux, plafonnés par `MAX_FEE_BPS`.
    constructor(address token_, address treasury_, address opener_, address settler_, uint16 feeBps_) {
        if (feeBps_ > MAX_FEE_BPS) revert BadFee();
        // I10, imposé ici et non plus seulement dans le script de déploiement.
        // Fusionnés, les deux rôles donnent à une seule clé le pouvoir d'ouvrir
        // un mandat sur des fonds déjà versés puis de le saisir dans la foulée —
        // sans frais, donc indiscernable d'une saisie légitime au regard de I6.
        if (opener_ == settler_) revert RolesMustDiffer();
        // Promus du script vers le contrat, pour la même raison que I10 :
        // un déploiement direct contourne le script.
        if (token_ == address(0) || treasury_ == address(0)) revert ZeroAddress();

        token = IERC20(token_);
        treasury = treasury_;
        opener = opener_;
        settler = settler_;
        owner = msg.sender;
        feeBps = feeBps_;

        emit OpenerChanged(address(0), opener_);
        emit SettlerChanged(address(0), settler_);
        emit FeeBpsChanged(0, feeBps_);
    }

    // ── Mutations ─────────────────────────────────────────────────────────

    /// @notice Ouvre un mandat, et **encaisse la caution dans la même transaction**.
    /// @dev    L'`agent` n'est plus un paramètre : il est dérivé de la signature
    ///         EIP-3009 de `auth`. C'est le cœur du correctif. Auparavant les
    ///         fonds arrivaient par un virement anonyme et l'`opener` déclarait
    ///         librement qui serait remboursé — or `agent` et `beneficiary` sont
    ///         les destinataires des TROIS sorties du contrat. Un opener seul
    ///         pouvait donc s'attribuer tout solde libre, sans le settler et
    ///         sans l'owner.
    ///
    ///         Financement et ouverture étant désormais atomiques, il n'existe
    ///         plus ni fenêtre de solde libre à capter, ni règlement orphelin si
    ///         l'ouverture échoue : tout révèrte ensemble.
    function open(
        bytes32 id,
        address beneficiary,
        uint256 bond,
        bytes32 conditionHash,
        bytes32 actionHash,
        uint64 duration,
        Authorization calldata auth
    ) external {
        if (msg.sender != opener) revert NotOpener();
        if (warrants[id].status != Status.None) revert AlreadyExists();
        if (bond == 0) revert ZeroBond();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        if (beneficiary == address(0) || auth.from == address(0)) revert ZeroAddress();
        // I6 vrai par construction : une saisie ne peut pas alimenter la
        // trésorerie du protocole, même via une politique mal configurée.
        if (beneficiary == treasury) revert BeneficiaryIsTreasury();
        // Deux bénéficiaires dégénérés, qui vident la caution de son sens :
        //   - l'agent lui-même : une saisie rembourserait le fautif ;
        //   - ce contrat : la caution disparaîtrait du passif sans en sortir,
        //     devenant un excédent que rien ne peut plus récupérer.
        if (beneficiary == auth.from || beneficiary == address(this)) revert BadBeneficiary();
        // Exactement la caution, ni plus ni moins : un excédent serait
        // irrécupérable, le contrat n'ayant aucune fonction de balayage.
        if (auth.value != bond) revert ValueMismatch();
        // L'autorisation EIP-3009 prouve QUI paie ; elle ne dit rien de CE QUI a
        // été accepté — son digest ne couvre que
        // (from, to, value, validAfter, validBefore, nonce). Sans le contrôle
        // ci-dessous, l'`opener` pourrait détourner une autorisation destinée à
        // un mandat vers un mandat aux termes de son choix : autre bénéficiaire,
        // autre post-condition, `duration` portée à MAX_DURATION.
        //
        // On exploite le fait que le `nonce` EST dans le digest signé : en le
        // contraignant à valoir le hash des termes, signer l'autorisation revient
        // à signer les termes. Une seule signature, liaison complète, et
        // l'unicité du nonce reste assurée par `id`.
        if (auth.nonce != termsHash(id, beneficiary, bond, conditionHash, actionHash, duration)) {
            revert TermsMismatch();
        }

        // Le paiement est tiré ICI, contre la signature de l'agent. Si elle ne
        // correspond pas à `auth.from`, le token révèrte et rien ne s'ouvre.
        // `auth.from` est donc l'agent, prouvé cryptographiquement.
        IERC3009(address(token)).receiveWithAuthorization(
            auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
        );

        // Addition volontairement *checked*. Le contrôle de solde qui suit est
        // désormais redondant — on vient d'encaisser exactement `bond` — mais on
        // le garde : I1 est un invariant déclaré, et une ligne de défense contre
        // un token qui mentirait sur son propre transfert coûte peu.
        totalLocked += bond;
        if (token.balanceOf(address(this)) < totalLocked) revert Underfunded();

        uint64 expiry = uint64(block.timestamp) + duration;

        warrants[id] = Warrant({
            agent: auth.from,
            beneficiary: beneficiary,
            bond: bond,
            conditionHash: conditionHash,
            actionHash: actionHash,
            // `fundingRef` cesse d'être décoratif : c'est le nonce EIP-3009,
            // dont le token garantit lui-même qu'il ne sert qu'une fois.
            fundingRef: auth.nonce,
            expiry: expiry,
            openedAt: uint64(block.timestamp),
            feeBpsAtOpen: feeBps,
            status: Status.Open
        });

        emit WarrantOpened(id, auth.from, beneficiary, bond, conditionHash, actionHash, auth.nonce, expiry);
    }

    /// @notice Post-condition tenue : rembourse `bond - fee` à l'agent.
    /// @dev    Fermé après `expiry` — voir invariant I9.
    function honor(bytes32 id, bytes32 execRef) external {
        if (msg.sender != settler) revert NotSettler();
        Warrant storage w = warrants[id];
        if (w.status != Status.Open) revert NotOpen();
        if (block.timestamp > w.expiry) revert Expired(); // I9 — fenêtre de règlement close

        w.status = Status.Honored; // effet avant interaction
        // Le taux figé à l'ouverture, pas le taux courant : les conditions
        // économiques d'un mandat ne bougent plus une fois l'agent engagé.
        uint256 fee = (w.bond * w.feeBpsAtOpen) / 10_000;
        uint256 refunded = w.bond - fee;
        totalLocked -= w.bond;

        // L'agent est payé AVANT la trésorerie. Entre les deux transferts,
        // `totalLocked` a déjà perdu `bond` entier ; payer l'agent d'abord
        // referme la fenêtre où le solde apparent excède le passif réel.
        token.safeTransfer(w.agent, refunded);
        if (fee > 0) token.safeTransfer(treasury, fee);

        emit WarrantHonored(id, execRef, refunded, fee);
    }

    /// @notice Post-condition violée : transfère l'intégralité de `bond` au bénéficiaire.
    /// @dev    Fermé après `expiry` — voir invariant I9. Aucun frais n'est prélevé (I6).
    function slash(bytes32 id, bytes32 execRef, string calldata reason) external {
        if (msg.sender != settler) revert NotSettler();
        Warrant storage w = warrants[id];
        if (w.status != Status.Open) revert NotOpen();
        if (block.timestamp > w.expiry) revert Expired(); // I9 — fenêtre de règlement close

        w.status = Status.Slashed;
        uint256 amount = w.bond;
        totalLocked -= amount;

        token.safeTransfer(w.beneficiary, amount); // intégralité, aucun frais sur une saisie
        emit WarrantSlashed(id, execRef, amount, reason);
    }

    /// @notice Après expiration, n'importe qui peut déclencher le remboursement intégral
    ///         à l'agent. Empêche toute séquestration par un settler défaillant.
    function reclaim(bytes32 id) external {
        // volontairement sans permission
        Warrant storage w = warrants[id];
        if (w.status != Status.Open) revert NotOpen();
        if (block.timestamp <= w.expiry) revert NotExpired();

        w.status = Status.Reclaimed;
        uint256 amount = w.bond;
        totalLocked -= amount;

        token.safeTransfer(w.agent, amount); // remboursement intégral, sans frais
        emit WarrantReclaimed(id, amount);
    }

    // ── Administration ────────────────────────────────────────────────────

    function setOpener(address next) external onlyOwner {
        if (next == settler) revert RolesMustDiffer(); // I10
        emit OpenerChanged(opener, next);
        opener = next;
    }

    function setSettler(address next) external onlyOwner {
        if (next == opener) revert RolesMustDiffer(); // I10
        emit SettlerChanged(settler, next);
        settler = next;
    }

    function setFeeBps(uint16 next) external onlyOwner {
        if (next > MAX_FEE_BPS) revert BadFee();
        emit FeeBpsChanged(feeBps, next);
        feeBps = next;
    }

    // ── Vues ──────────────────────────────────────────────────────────────

    /// @notice Le nonce EIP-3009 qu'une autorisation doit porter pour ce mandat.
    /// @dev    Exposé pour que le client dérive exactement ce que le contrat
    ///         attend, plutôt que de réimplémenter la formule et de diverger.
    function termsHash(
        bytes32 id,
        address beneficiary,
        uint256 bond,
        bytes32 conditionHash,
        bytes32 actionHash,
        uint64 duration
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(id, beneficiary, bond, conditionHash, actionHash, duration));
    }

    /// @notice Renvoie le mandat complet en une seule lecture (le getter public généré
    ///         renvoie un tuple, malcommode côté indexeur et côté tests).
    function getWarrant(bytes32 id) external view returns (Warrant memory) {
        return warrants[id];
    }
}
