// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice The subset of EIP-3009 that funding a warrant depends on.
/// @dev    `receiveWithAuthorization` and not `transferWithAuthorization`: the
///         `receive` variant enforces `to == msg.sender`. Without it, anyone
///         could intercept the signed authorization and submit it straight to
///         the token — the funds would still land here, but the `nonce` would
///         be consumed and the legitimate `open` would revert. We would have
///         traded a theft for a denial of service that recreates the very
///         problem of orphaned funds.
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

/// @title WarrantEscrow — bonds for agent actions executed through KeeperHub
/// @notice A warrant ties a bond to an onchain post-condition committed to before execution.
/// @dev    A single contract: no governance, no proxy, no emergency withdrawal function.
///         Funds can only leave through `honor`, `slash` or `reclaim`.
contract WarrantEscrow {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Honored,
        Slashed,
        Reclaimed
    }

    /// @notice An EIP-3009 authorization signed by the agent, exactly as the
    ///         `exact` scheme of x402 already carries it.
    struct Authorization {
        address from; // the agent — PROVEN by the signature, never declared
        uint256 value; // must equal `bond` exactly
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce; // uniqueness guaranteed by the token itself
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Warrant {
        address agent; // pays the bond, receives the refund
        address beneficiary; // receives the funds if the bond is slashed
        uint256 bond; // amount in atomic USDC units
        bytes32 conditionHash; // keccak256(JCS(conditionSpec)) — immutable commitment
        bytes32 actionHash; // keccak256(JCS(actionSpec))
        bytes32 fundingRef; // hash of the x402 tx that funded the bond
        uint64 expiry; // past it: honor/slash closed, reclaim open to anyone
        uint64 openedAt;
        uint16 feeBpsAtOpen; // frozen here: the economic terms no longer move
        Status status;
    }

    IERC20 public immutable token;
    address public immutable treasury; // receives the fees
    address public opener; // the only address allowed to open — the Gateway
    address public settler; // the only address allowed to honor/slash — the Settler
    address public owner; // can rotate opener and settler
    uint16 public feeBps; // fee taken on refund, ≤ MAX_FEE_BPS

    uint256 public totalLocked; // sum of the bonds in Open status

    uint16 public constant MAX_FEE_BPS = 500; // 5 % — hard-coded ceiling
    uint64 public constant MIN_DURATION = 15 minutes; // must cover execution + confirmations
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

    /// @param token_    the target chain's native USDC — frozen, `immutable`.
    /// @param treasury_ recipient of the fees taken on honored warrants.
    /// @param opener_   the Gateway: the only address allowed to open a warrant.
    /// @param settler_  the Settler: the only address allowed to honor or slash.
    /// @param feeBps_   initial fee, capped by `MAX_FEE_BPS`.
    constructor(address token_, address treasury_, address opener_, address settler_, uint16 feeBps_) {
        if (feeBps_ > MAX_FEE_BPS) revert BadFee();
        // I10, enforced here and no longer only in the deployment script.
        // Merged, the two roles hand a single key the power to open a warrant
        // against funds already paid in and then slash it in the same breath —
        // with no fee, hence indistinguishable from a legitimate slash under I6.
        if (opener_ == settler_) revert RolesMustDiffer();
        // Promoted from the script into the contract, for the same reason as
        // I10: a direct deployment bypasses the script.
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

    /// @notice Opens a warrant, and **collects the bond in the same transaction**.
    /// @dev    `agent` is no longer a parameter: it is derived from the EIP-3009
    ///         signature carried by `auth`. This is the heart of the fix.
    ///         Previously the funds arrived by an anonymous transfer and the
    ///         `opener` freely declared who would be refunded — yet `agent` and
    ///         `beneficiary` are the recipients of ALL THREE exits of the
    ///         contract. An opener acting alone could therefore award itself any
    ///         unattached balance, without the settler and without the owner.
    ///
    ///         Funding and opening now being atomic, there is no longer either a
    ///         window of unattached balance to capture, or an orphaned
    ///         settlement should the opening fail: everything reverts together.
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
        // I6 true by construction: a slash cannot feed the protocol's own
        // treasury, not even through a misconfigured policy.
        if (beneficiary == treasury) revert BeneficiaryIsTreasury();
        // Two degenerate beneficiaries, both of which drain the bond of its
        // meaning:
        //   - the agent itself: a slash would refund the party at fault;
        //   - this contract: the bond would vanish from the liabilities without
        //     ever leaving, becoming a surplus nothing can recover any more.
        if (beneficiary == auth.from || beneficiary == address(this)) revert BadBeneficiary();
        // Exactly the bond, no more and no less: an excess would be
        // unrecoverable, the contract having no sweep function whatsoever.
        if (auth.value != bond) revert ValueMismatch();
        // The EIP-3009 authorization proves WHO pays; it says nothing about WHAT
        // was agreed to — its digest only covers
        // (from, to, value, validAfter, validBefore, nonce). Without the check
        // below, the `opener` could divert an authorization meant for one
        // warrant towards a warrant on terms of its own choosing: another
        // beneficiary, another post-condition, `duration` stretched to
        // MAX_DURATION.
        //
        // We exploit the fact that the `nonce` IS part of the signed digest: by
        // constraining it to equal the hash of the terms, signing the
        // authorization amounts to signing the terms. A single signature, a
        // complete binding, and nonce uniqueness is still assured by `id`.
        if (auth.nonce != termsHash(id, beneficiary, bond, conditionHash, actionHash, duration)) {
            revert TermsMismatch();
        }

        // The payment is pulled HERE, against the agent's signature. If it does
        // not match `auth.from`, the token reverts and nothing opens.
        // `auth.from` is therefore the agent, cryptographically proven.
        IERC3009(address(token)).receiveWithAuthorization(
            auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
        );

        // Addition deliberately left *checked*. The balance check that follows
        // is now redundant — we just collected exactly `bond` — but we keep it:
        // I1 is a declared invariant, and one more line of defence against a
        // token that would lie about its own transfer costs little.
        totalLocked += bond;
        if (token.balanceOf(address(this)) < totalLocked) revert Underfunded();

        uint64 expiry = uint64(block.timestamp) + duration;

        warrants[id] = Warrant({
            agent: auth.from,
            beneficiary: beneficiary,
            bond: bond,
            conditionHash: conditionHash,
            actionHash: actionHash,
            // `fundingRef` stops being decorative: it is the EIP-3009 nonce,
            // which the token itself guarantees can only ever be used once.
            fundingRef: auth.nonce,
            expiry: expiry,
            openedAt: uint64(block.timestamp),
            feeBpsAtOpen: feeBps,
            status: Status.Open
        });

        emit WarrantOpened(id, auth.from, beneficiary, bond, conditionHash, actionHash, auth.nonce, expiry);
    }

    /// @notice Post-condition met: refunds `bond - fee` to the agent.
    /// @dev    Closed after `expiry` — see invariant I9.
    function honor(bytes32 id, bytes32 execRef) external {
        if (msg.sender != settler) revert NotSettler();
        Warrant storage w = warrants[id];
        if (w.status != Status.Open) revert NotOpen();
        if (block.timestamp > w.expiry) revert Expired(); // I9 — settlement window closed

        w.status = Status.Honored; // effect before interaction
        // The rate frozen at open, not the current one: the economic terms of a
        // warrant no longer move once the agent has committed.
        uint256 fee = (w.bond * w.feeBpsAtOpen) / 10_000;
        uint256 refunded = w.bond - fee;
        totalLocked -= w.bond;

        // The agent is paid BEFORE the treasury. Between the two transfers,
        // `totalLocked` has already shed the whole `bond`; paying the agent
        // first closes the window in which the apparent balance exceeds the
        // actual liability.
        token.safeTransfer(w.agent, refunded);
        if (fee > 0) token.safeTransfer(treasury, fee);

        emit WarrantHonored(id, execRef, refunded, fee);
    }

    /// @notice Post-condition breached: transfers the whole `bond` to the beneficiary.
    /// @dev    Closed after `expiry` — see invariant I9. No fee is taken (I6).
    function slash(bytes32 id, bytes32 execRef, string calldata reason) external {
        if (msg.sender != settler) revert NotSettler();
        Warrant storage w = warrants[id];
        if (w.status != Status.Open) revert NotOpen();
        if (block.timestamp > w.expiry) revert Expired(); // I9 — settlement window closed

        w.status = Status.Slashed;
        uint256 amount = w.bond;
        totalLocked -= amount;

        token.safeTransfer(w.beneficiary, amount); // in full, no fee on a slash
        emit WarrantSlashed(id, execRef, amount, reason);
    }

    /// @notice Once expired, anyone may trigger the full refund to the agent.
    ///         Stops a failing settler from holding the bond hostage.
    function reclaim(bytes32 id) external {
        // deliberately permissionless
        Warrant storage w = warrants[id];
        if (w.status != Status.Open) revert NotOpen();
        if (block.timestamp <= w.expiry) revert NotExpired();

        w.status = Status.Reclaimed;
        uint256 amount = w.bond;
        totalLocked -= amount;

        token.safeTransfer(w.agent, amount); // refunded in full, no fee
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

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice The EIP-3009 nonce an authorization must carry for this warrant.
    /// @dev    Exposed so that the client derives exactly what the contract
    ///         expects, rather than reimplementing the formula and diverging.
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

    /// @notice Returns the whole warrant in a single read (the generated public getter
    ///         returns a tuple, awkward both for indexers and for tests).
    function getWarrant(bytes32 id) external view returns (Warrant memory) {
        return warrants[id];
    }
}
