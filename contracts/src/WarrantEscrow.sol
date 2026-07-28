// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";

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

    struct Warrant {
        address agent; // payeur de la caution, destinataire du remboursement
        address beneficiary; // destinataire en cas de saisie
        uint256 bond; // montant en unités atomiques USDC
        bytes32 conditionHash; // keccak256(JCS(conditionSpec)) — engagement immuable
        bytes32 actionHash; // keccak256(JCS(actionSpec))
        bytes32 fundingRef; // hash de la tx x402 qui a financé la caution
        uint64 expiry; // au-delà : honor/slash fermés, reclaim ouvert à tous
        uint64 openedAt;
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

    /// @notice Ouvre un mandat. Réservé à l'`opener` (le Gateway). Les fonds doivent déjà
    ///         avoir été transférés au contrat (règlement x402 vers `payTo` = adresse de ce
    ///         contrat). `fundingRef` fournit la trace d'audit reliant la caution au mandat.
    function open(
        bytes32 id,
        address agent,
        address beneficiary,
        uint256 bond,
        bytes32 conditionHash,
        bytes32 actionHash,
        bytes32 fundingRef,
        uint64 duration
    ) external {
        if (msg.sender != opener) revert NotOpener();
        if (warrants[id].status != Status.None) revert AlreadyExists();
        if (bond == 0) revert ZeroBond();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();

        // Les fonds doivent déjà être présents : le règlement x402 les a transférés ici.
        // On ne vérifie pas un solde par mandat (l'USDC est fongible) mais on comptabilise,
        // et on refuse d'ouvrir un mandat que le contrat ne pourrait pas honorer.
        // Addition volontairement *checked* : un overflow ferait repasser `totalLocked`
        // sous le solde réel et laisserait passer un mandat non financé.
        totalLocked += bond;
        if (token.balanceOf(address(this)) < totalLocked) revert Underfunded();

        uint64 expiry = uint64(block.timestamp) + duration;

        warrants[id] = Warrant({
            agent: agent,
            beneficiary: beneficiary,
            bond: bond,
            conditionHash: conditionHash,
            actionHash: actionHash,
            fundingRef: fundingRef,
            expiry: expiry,
            openedAt: uint64(block.timestamp),
            status: Status.Open
        });

        emit WarrantOpened(id, agent, beneficiary, bond, conditionHash, actionHash, fundingRef, expiry);
    }

    /// @notice Post-condition tenue : rembourse `bond - fee` à l'agent.
    /// @dev    Fermé après `expiry` — voir invariant I9.
    function honor(bytes32 id, bytes32 execRef) external {
        if (msg.sender != settler) revert NotSettler();
        Warrant storage w = warrants[id];
        if (w.status != Status.Open) revert NotOpen();
        if (block.timestamp > w.expiry) revert Expired(); // I9 — fenêtre de règlement close

        w.status = Status.Honored; // effet avant interaction
        uint256 fee = (w.bond * feeBps) / 10_000;
        uint256 refunded = w.bond - fee;
        totalLocked -= w.bond;

        if (fee > 0) token.safeTransfer(treasury, fee);
        token.safeTransfer(w.agent, refunded);

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
        emit OpenerChanged(opener, next);
        opener = next;
    }

    function setSettler(address next) external onlyOwner {
        emit SettlerChanged(settler, next);
        settler = next;
    }

    function setFeeBps(uint16 next) external onlyOwner {
        if (next > MAX_FEE_BPS) revert BadFee();
        emit FeeBpsChanged(feeBps, next);
        feeBps = next;
    }

    // ── Vues ──────────────────────────────────────────────────────────────

    /// @notice Renvoie le mandat complet en une seule lecture (le getter public généré
    ///         renvoie un tuple, malcommode côté indexeur et côté tests).
    function getWarrant(bytes32 id) external view returns (Warrant memory) {
        return warrants[id];
    }
}
