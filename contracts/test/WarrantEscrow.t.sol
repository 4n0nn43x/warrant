// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {AuthSigner} from "./helpers/AuthSigner.sol";

/// @title Unit tests for `WarrantEscrow`
/// @dev Covers the test plan of `06-contrat-escrow.md` § 5, including the cases dedicated to I9.
///
///      Post-audit migration: `open` now collects the bond itself via EIP-3009,
///      and `agent` is no longer a parameter but the outcome of a signature
///      verification. Two consequences for this whole suite:
///        1. `agent` is an account that carries a key (`makeAddrAndKey`), not a
///           decorative `makeAddr` — with no key, nothing can be opened at all;
///        2. funding no longer precedes the opening, it *is* the opening. The
///           funds leave the agent's balance, not an anonymous transfer made to
///           the contract beforehand. `_fund` therefore credits the agent, not
///           the escrow.
contract WarrantEscrowTest is AuthSigner {
    WarrantEscrow internal escrow;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal opener = makeAddr("opener"); // the Gateway
    address internal settler = makeAddr("settler"); // the Settler — a distinct key (I10)
    address internal beneficiary = makeAddr("beneficiary");
    address internal stranger = makeAddr("stranger");

    /// @dev The agent must be able to SIGN: it is the signature, and no longer a
    ///      declaration made by the opener, that identifies it as the bond's payer.
    address internal agent;
    uint256 internal agentKey;

    uint16 internal constant FEE_BPS = 250; // 2.5 %
    uint256 internal constant BOND = 100e6; // 100 USDC
    uint64 internal constant DURATION = 1 hours;

    bytes32 internal constant ID = keccak256("warrant-1");
    bytes32 internal constant ID2 = keccak256("warrant-2");
    bytes32 internal constant CONDITION_HASH = keccak256("conditionSpec");
    bytes32 internal constant ACTION_HASH = keccak256("actionSpec");
    bytes32 internal constant EXEC_REF = keccak256("keeperhub-exec");

    /// @dev Nonce counter, reserved for **deliberately non-conforming**
    ///      authorizations. Since the latest fix, the nonce of a legitimate
    ///      authorization is no longer free: it equals `termsHash(terms)`.
    ///      A nonce drawn from a counter therefore only serves to exercise the
    ///      guards placed BEFORE the terms check (`ZeroBond`, `BadDuration`,
    ///      `ZeroAddress`, the degenerate beneficiaries, `ValueMismatch`) — for
    ///      those, nonce conformity is beside the point, and an arbitrary value
    ///      avoids suggesting that the test depends on the binding.
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
        vm.warp(1_700_000_000); // a realistic timestamp: keeps us clear of the zero bounds
        (agent, agentKey) = makeAddrAndKey("agent");
        usdc = new MockUSDC();
        vm.prank(owner);
        escrow = new WarrantEscrow(address(usdc), treasury, opener, settler, FEE_BPS);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    function _nextNonce() internal returns (bytes32) {
        return keccak256(abi.encode("x402-nonce", ++nonceSeq));
    }

    /// @dev Credits the AGENT, and no longer the contract: the x402 settlement no
    ///      longer arrives as an anonymous transfer made beforehand. That changes
    ///      the nature of the funding, not merely the name of its recipient.
    function _fund(uint256 amount) internal {
        usdc.mint(agent, amount);
    }

    /// @dev The suite's standard terms, parameterised by whatever varies.
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

    /// @dev An authorization with an arbitrary nonce: it does NOT clear the terms
    ///      check. Reserved for the guards that apply upstream of it.
    function _looseAuth(uint256 value) internal returns (WarrantEscrow.Authorization memory) {
        return _auth(usdc, address(escrow), agent, agentKey, value, _nextNonce());
    }

    /// @dev A legitimate authorization: nonce derived from the warrant's exact terms.
    function _agentAuth(bytes32 id, uint256 bond, uint64 duration)
        internal
        view
        returns (WarrantEscrow.Authorization memory)
    {
        return _authForTerms(escrow, usdc, agent, agentKey, _terms(id, bond, duration));
    }

    /// @dev The authorization is built BEFORE the `vm.prank`, and never inside
    ///      `open`'s argument list: `_authForTerms` queries `escrow.termsHash`,
    ///      and that call would consume the prank — `open` would then come from
    ///      the wrong caller and revert on `NotOpener`. This is the second time
    ///      that trap has sprung in this suite.
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

    // ── Constructor & initial state ───────────────────────────────────────

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

    /// @dev I10 — now enforced by the contract itself, and no longer only by the
    ///      deployment script, which remained bypassable: nothing compels a
    ///      deployer to go through the script.
    function test_Constructor_RevertsWhenRolesAreMerged() public {
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        new WarrantEscrow(address(usdc), treasury, opener, opener, FEE_BPS);
    }

    /// @dev `token` and `treasury` used to be checked by the deployment script
    ///      alone — the very asymmetry that was held against I10. They are now
    ///      checked where it counts. `treasury == 0` together with a non-zero fee
    ///      would have made every `honor` impossible on real USDC, freezing each
    ///      bond until its expiry.
    function test_Constructor_RevertsOnZeroTokenOrTreasury() public {
        vm.expectRevert(WarrantEscrow.ZeroAddress.selector);
        new WarrantEscrow(address(0), treasury, opener, settler, FEE_BPS);

        vm.expectRevert(WarrantEscrow.ZeroAddress.selector);
        new WarrantEscrow(address(usdc), address(0), opener, settler, FEE_BPS);
    }

    /// @dev No emergency withdrawal function — that is deliberate. Not even the owner can
    ///      extract a single cent: funds only leave through honor, slash or reclaim.
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
            assertFalse(ok, "a withdrawal function exists");
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
        // `agent` was never declared by anyone: it comes out of the signature.
        assertEq(w.agent, agent, "agent derived from the signature");
        assertEq(w.beneficiary, beneficiary);
        assertEq(w.bond, BOND);
        assertEq(w.conditionHash, CONDITION_HASH);
        assertEq(w.actionHash, ACTION_HASH);
        assertEq(w.fundingRef, nonce, "fundingRef == EIP-3009 nonce");
        // And that nonce is not an opaque blob: it hashes the warrant's terms. The
        // `fundingRef` is therefore verifiable by anyone from the onchain state
        // alone — that is what turns the agent's signature into consent to the
        // terms, and no longer merely a payment order.
        assertEq(
            w.fundingRef,
            escrow.termsHash(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION),
            "fundingRef == termsHash of the warrant terms"
        );
        assertEq(w.openedAt, uint64(block.timestamp));
        assertEq(w.expiry, uint64(block.timestamp) + DURATION);
        assertEq(w.feeBpsAtOpen, FEE_BPS, "rate frozen at open");
        assertEq(uint8(w.status), uint8(WarrantEscrow.Status.Open));
        assertEq(escrow.totalLocked(), BOND);

        // Atomic funding: the funds left the agent within this very transaction,
        // and the nonce is consumed on the token's side.
        assertEq(usdc.balanceOf(agent), 0, "the bond has left the agent");
        assertEq(usdc.balanceOf(address(escrow)), BOND);
        assertTrue(usdc.authorizationState(agent, nonce), "nonce consumed");
    }

    /// @dev The generated public getter now returns TEN fields — `feeBpsAtOpen`
    ///      slots in before `status`. We decode the whole tuple: that is what the
    ///      indexer does, and a silent insertion in the middle of a tuple is
    ///      exactly the kind of change that breaks an offchain consumer without
    ///      any high-level test ever noticing.
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

    /// @dev I10 — a third party cannot open.
    function test_Open_RevertsWhenNotOpener() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(stranger);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev I10 — the roles are disjoint: the settler cannot open.
    function test_Open_RevertsWhenCallerIsSettler() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev I10 — nor can the owner (it rotates the roles, it does not exercise them).
    function test_Open_RevertsWhenCallerIsOwner() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.NotOpener.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Fresh nonce and sufficient balance: the only possible ground for
    ///      refusal is the identifier already being taken. Without that
    ///      precaution the test would go green on `AuthorizationUsed` while
    ///      proving nothing about `AlreadyExists`.
    function test_Open_RevertsOnDuplicateId() public {
        _openFunded(ID, BOND, DURATION);
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.AlreadyExists.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev A settled id stays consumed: no recycling of identifiers.
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

    /// @dev Formerly `test_Open_RevertsWhenUnderfunded`, rewritten. Underfunding
    ///      no longer shows up as `Underfunded()`: the contract no longer observes
    ///      a pre-existing balance, it pulls the payment. It is therefore the
    ///      TOKEN that arbitrates, by refusing to debit an insolvent agent; `open`
    ///      reverts along with it and no warrant exists. The original intent ("a
    ///      warrant does not open without the funds") is preserved; the layer that
    ///      enforces it is what changes.
    function test_Open_RevertsWhenAgentCannotPay() public {
        _fund(BOND - 1);
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(MockUSDC.InsufficientBalance.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        assertEq(escrow.totalLocked(), 0, "no commitment was taken");
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.None));
        assertEq(usdc.balanceOf(agent), BOND - 1, "the agent's funds have not moved");
    }

    /// @dev Second half: `Underfunded()` has become UNREACHABLE with an honest
    ///      token. The contract's balance is permanently equal to `totalLocked` —
    ///      and not merely greater than it — since every opening collects exactly
    ///      its bond. The guard survives as a defence against a token that would
    ///      lie about its own transfer; what we document here is that no sequence
    ///      of legitimate calls can trigger it any more.
    function test_Open_UnderfundedIsNowUnreachable() public {
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked());
        _openFunded(ID, BOND, DURATION);
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked(), "equality, not inequality");
        _openFunded(ID2, 3 * BOND, DURATION);
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked());
        assertEq(escrow.totalLocked(), 4 * BOND);
    }

    /// @dev Formerly `test_Open_RevertsWhenSecondWarrantReusesSameFunds`, first
    ///      half. The old scenario — two warrants backed by the same transfer — is
    ///      no longer expressible: there is no separate transfer left to reuse. And
    ///      now that the nonce equals `termsHash(terms)`, `id` included, an
    ///      authorization can no longer **by construction** designate another
    ///      warrant: it is refused on `TermsMismatch`, before the token even has to
    ///      observe that its nonce is spent. The protection went from one layer to
    ///      two, and the first one is the contract's.
    function test_Open_SecondWarrantCannotReuseTheSameAuthorization() public {
        _fund(2 * BOND); // balance far more than enough: the refusal will not come from there
        WarrantEscrow.Authorization memory auth = _agentAuth(ID, BOND, DURATION);

        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Same authorization, different identifier: the terms no longer match.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID2, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Same authorization, same identifier: the identifier is already consumed.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.AlreadyExists.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        assertEq(escrow.totalLocked(), BOND, "a single warrant funded");
        assertEq(usdc.balanceOf(agent), BOND, "the agent was debited only once");
    }

    /// @dev Second half: each warrant demands its own capital. Fresh nonce, but the
    ///      balance is already exhausted — the opening fails on the token's side.
    function test_Open_SecondWarrantNeedsItsOwnFunds() public {
        _openFunded(ID, BOND, DURATION); // the agent has paid in its entire balance
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
        _fund(2 * BOND); // two warrants, two distinct fundings
        _open(ID, BOND, escrow.MIN_DURATION());
        _open(ID2, BOND, escrow.MAX_DURATION());

        assertEq(escrow.getWarrant(ID).expiry, uint64(block.timestamp) + escrow.MIN_DURATION());
        assertEq(escrow.getWarrant(ID2).expiry, uint64(block.timestamp) + escrow.MAX_DURATION());
        assertEq(escrow.totalLocked(), 2 * BOND);
    }

    // ── open: the guards added by the audit ───────────────────────────────

    function test_Open_RevertsOnZeroBeneficiary() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ZeroAddress.selector);
        escrow.open(ID, address(0), BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev `auth.from == 0` is caught BEFORE the call to the token. The mock does
    ///      not reproduce FiatTokenV2_2's refusal of `address(0)`: what this test
    ///      exercises is therefore the contract's guard, and not the token's.
    function test_Open_RevertsOnZeroAuthFrom() public {
        WarrantEscrow.Authorization memory auth =
            _auth(usdc, address(escrow), address(0), agentKey, BOND, _nextNonce());
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ZeroAddress.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev I6 true by construction: a slash cannot feed the treasury.
    function test_Open_RevertsWhenBeneficiaryIsTreasury() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BeneficiaryIsTreasury.selector);
        escrow.open(ID, treasury, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Degenerate beneficiary: a slash would refund the party at fault, and
    ///      the bond would stop being a bond.
    function test_Open_RevertsWhenBeneficiaryIsAgent() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BadBeneficiary.selector);
        escrow.open(ID, agent, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Degenerate beneficiary: the bond would leave the liabilities without
    ///      leaving the contract, becoming an unrecoverable surplus (no sweep exists).
    function test_Open_RevertsWhenBeneficiaryIsEscrow() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BadBeneficiary.selector);
        escrow.open(ID, address(escrow), BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
    }

    /// @dev Both directions of the mismatch. A surplus is just as serious as a
    ///      shortfall: it would be frozen forever.
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

    /// @dev The nonce must hash the terms. An arbitrary nonce — even one perfectly
    ///      signed by the agent — is refused: otherwise the agent would be signing
    ///      a payment order with no idea what it is backing.
    function test_Open_RevertsOnArbitraryNonce() public {
        _fund(BOND);
        WarrantEscrow.Authorization memory auth = _looseAuth(BOND);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
        assertEq(escrow.totalLocked(), 0);
    }

    /// @dev The six components of the terms, one by one. Every field the `opener`
    ///      might want to substitute after the fact is covered by the signed nonce,
    ///      and therefore locked. This is the single most valuable test here: it
    ///      exhaustively enumerates the diversion surface.
    function test_Open_RevertsWhenAnyTermIsSubstituted() public {
        _fund(BOND);
        Terms memory t = _terms(ID, BOND, DURATION);
        WarrantEscrow.Authorization memory auth = _authForTerms(escrow, usdc, agent, agentKey, t);
        address other = makeAddr("other-beneficiary");
        // Read now: under `vm.expectRevert`, it is the NEXT call that is watched —
        // and evaluating an argument is a call. `MAX_DURATION()` inside the
        // argument list would capture the expectation and would not revert.
        uint64 maxDuration = escrow.MAX_DURATION();

        // (1) a different identifier
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID2, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // (2) a different beneficiary — the most profitable substitution for the opener
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, other, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // (3) a different post-condition: the agent would be judged against a
        //     criterion it never agreed to
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, keccak256("other-condition"), ACTION_HASH, DURATION, auth);

        // (4) a different action
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, keccak256("other-action"), DURATION, auth);

        // (5) a different duration: a longer lock-up without consent
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, maxDuration, auth);

        // (6) the amount is already covered by `ValueMismatch`, which applies
        //     upstream: a `bond` differing from `auth.value` is refused before the terms.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ValueMismatch.selector);
        escrow.open(ID, beneficiary, BOND + 1, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Nothing was opened, and the original terms remain honourable.
        assertEq(escrow.totalLocked(), 0, "no substitution got through");
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
        assertEq(escrow.totalLocked(), BOND, "the signed terms, on the other hand, do pass");
    }

    /// @dev The signature is the only link between `auth.from` and the payment. An
    ///      authorization whose key does not match `from` is rejected by the token:
    ///      that is what forbids anyone from *designating* an agent.
    function test_Open_RevertsOnForgedSignature() public {
        _fund(BOND);
        (, uint256 wrongKey) = makeAddrAndKey("not-the-agent");
        // Perfectly conforming terms — only the key is the wrong one. The terms
        // check therefore passes, and it really is the token's signature
        // verification that rejects: the property aimed at is isolated exactly.
        WarrantEscrow.Authorization memory forged =
            _authForTerms(escrow, usdc, agent, wrongKey, _terms(ID, BOND, DURATION));
        vm.prank(opener);
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, forged);
    }

    // ── honor ─────────────────────────────────────────────────────────────

    /// @dev I8 — the agent receives exactly bond − bond·feeBps/10000.
    function test_Honor_TransfersBondMinusFee() public {
        _openFunded(ID, BOND, DURATION);

        uint256 expectedFee = (BOND * FEE_BPS) / 10_000; // 2.5 USDC
        uint256 expectedRefund = BOND - expectedFee; // 97.5 USDC
        assertEq(expectedRefund, 97_500_000, "97.5 % of the bond");

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

    /// @dev The order of the two transfers was flipped by the fix: the agent
    ///      first, the treasury second. `totalLocked` is already decremented by
    ///      the WHOLE bond before the transfers; paying the treasury first left an
    ///      interval in which the contract's balance exceeded its declared
    ///      liability. So what we check is the actual order of the `Transfer`
    ///      events, and not the final balances — identical under either order,
    ///      they prove nothing.
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

        assertEq(seen, 2, "exactly two transfers");
        assertEq(recipients[0], agent, "the agent is paid first");
        assertEq(recipients[1], treasury, "the treasury second");
    }

    /// @dev The rate is frozen at open: changing `feeBps` afterwards no longer
    ///      alters the economic terms of a warrant already under way.
    function test_Honor_UsesFeeFrozenAtOpen() public {
        _openFunded(ID, BOND, DURATION);
        // `MAX_FEE_BPS()` is read BEFORE the prank: evaluated as an argument, it
        // would consume the `vm.prank` and `setFeeBps` would come from the wrong caller.
        uint16 maxFee = escrow.MAX_FEE_BPS();
        vm.prank(owner);
        escrow.setFeeBps(maxFee); // 250 → 500 bps

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        uint256 feeAtOpen = (BOND * FEE_BPS) / 10_000; // 2.5 USDC
        assertEq(usdc.balanceOf(treasury), feeAtOpen, "fee at the rate in force at open");
        assertEq(usdc.balanceOf(agent), BOND - feeAtOpen);
        assertEq(escrow.feeBps(), 500, "the current rate really did change");
        assertEq(escrow.getWarrant(ID).feeBpsAtOpen, FEE_BPS, "the warrant's own rate stays frozen");
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

    /// @dev I10 — the opener cannot settle.
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

    /// @dev I2 — a warrant leaves `Open` exactly once.
    function test_Honor_ThenHonor_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.startPrank(settler);
        escrow.honor(ID, EXEC_REF);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.honor(ID, EXEC_REF);
        vm.stopPrank();
    }

    /// @dev I2 — no slash after a refund.
    function test_Honor_ThenSlash_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.startPrank(settler);
        escrow.honor(ID, EXEC_REF);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.slash(ID, EXEC_REF, "too late");
        vm.stopPrank();
    }

    function test_Honor_UnknownId_Reverts() public {
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.honor(keccak256("unknown"), EXEC_REF);
    }

    // ── slash ─────────────────────────────────────────────────────────────

    /// @dev I6 — no commission whatsoever on a slash.
    function test_Slash_TransfersFullBondNoFee() public {
        _openFunded(ID, BOND, DURATION);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit WarrantSlashed(ID, EXEC_REF, BOND, "post-condition breached");
        vm.prank(settler);
        escrow.slash(ID, EXEC_REF, "post-condition breached");

        assertEq(usdc.balanceOf(beneficiary), BOND, "the whole bond to the beneficiary");
        assertEq(usdc.balanceOf(treasury), 0, "no fee taken (I6)");
        assertEq(usdc.balanceOf(agent), 0);
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Slashed));
    }

    /// @dev I6 — true whatever the value of `feeBps`, the cap included.
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

    /// @dev I10 — the opener cannot slash.
    function test_Slash_RevertsWhenCallerIsOpener() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.slash(ID, EXEC_REF, "violation");
    }

    function test_Slash_RevertsWhenNotSettler() public {
        _openFunded(ID, BOND, DURATION);
        vm.prank(beneficiary); // not even the beneficiary may help itself
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

    /// @dev `reclaim`'s bound mirrors `honor`'s exactly: at `expiry` on the dot,
    ///      settlement is still open and `reclaim` is still closed.
    function test_Reclaim_RevertsAtExactExpiry() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry);
        vm.expectRevert(WarrantEscrow.NotExpired.selector);
        escrow.reclaim(ID);
    }

    /// @dev I5 — anyone can unlock, and the agent is refunded in full.
    function test_Reclaim_ByStrangerAfterExpiry_RefundsAgentInFull() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit WarrantReclaimed(ID, BOND);
        vm.prank(stranger);
        escrow.reclaim(ID);

        assertEq(usdc.balanceOf(agent), BOND, "refunded in full, no fee");
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(stranger), 0, "no bounty for whoever triggers it");
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

    // ── I9: the settlement window is closed after `expiry` ────────────────

    /// @dev I9 — the bound is `>`, not `>=`: at exactly `expiry`, `honor` still goes through.
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

    /// @dev I9 — the bound is `>`, not `>=`: at exactly `expiry`, `slash` still goes through.
    function test_I9_SlashAtExactExpiry_Succeeds() public {
        _openFunded(ID, BOND, DURATION);
        uint64 expiry = escrow.getWarrant(ID).expiry;

        vm.warp(expiry);
        vm.prank(settler);
        escrow.slash(ID, EXEC_REF, "violation");

        assertEq(usdc.balanceOf(beneficiary), BOND);
    }

    /// @dev I9 — one second later, the settler's power is extinguished.
    function test_I9_HonorAtExpiryPlusOne_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.honor(ID, EXEC_REF);
    }

    /// @dev I9 — same story for the slash.
    function test_I9_SlashAtExpiryPlusOne_Reverts() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.slash(ID, EXEC_REF, "too late");
    }

    /// @dev I9 — even very long afterwards, nothing reopens the window.
    function test_I9_SettlerPowerIsPermanentlyExtinguished() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 365 days);
        vm.startPrank(settler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.honor(ID, EXEC_REF);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.slash(ID, EXEC_REF, "too late");
        vm.stopPrank();

        // The warrant stays `Open`, and reclaimable by anyone.
        escrow.reclaim(ID);
        assertEq(usdc.balanceOf(agent), BOND);
    }

    /// @dev I9 — rotating the settler does not reopen the window: the bound is temporal,
    ///      not tied to an identity. A compromised owner cannot work around it.
    function test_I9_RotatingSettlerDoesNotReopenWindow() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);

        address newSettler = makeAddr("newSettler");
        vm.prank(owner);
        escrow.setSettler(newSettler);

        vm.prank(newSettler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.slash(ID, EXEC_REF, "too late");
    }

    /// @notice **The central test of the revision**: a front-running scenario.
    ///         Expired warrant; the hostile settler and a third party submit `slash` and
    ///         `reclaim` in the **same block**, the `slash` being mined first. The `slash`
    ///         reverts, the `reclaim` succeeds, the agent is refunded in full.
    function test_I9_FrontRunScenario_SlashRevertsReclaimSucceeds() public {
        _openFunded(ID, BOND, DURATION);
        uint64 expiry = escrow.getWarrant(ID).expiry;

        // One and the same block: we freeze both the timestamp and the block number.
        vm.warp(expiry + 1);
        vm.roll(block.number + 1);
        uint256 blockNumber = block.number;
        uint256 blockTimestamp = block.timestamp;

        // Transaction 1 of the block: the settler front-runs the reclaim it sees in the mempool.
        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.Expired.selector);
        escrow.slash(ID, EXEC_REF, "hostile slash after expiry");

        // The front-run failed: the warrant is intact.
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Open));
        assertEq(escrow.totalLocked(), BOND);

        // Transaction 2 of the same block: the permissionless reclaim goes through.
        assertEq(block.number, blockNumber, "same block");
        assertEq(block.timestamp, blockTimestamp, "same block");
        vm.prank(stranger);
        escrow.reclaim(ID);

        assertEq(usdc.balanceOf(agent), BOND, "agent refunded in full");
        assertEq(usdc.balanceOf(beneficiary), 0, "nothing for the beneficiary");
        assertEq(usdc.balanceOf(treasury), 0, "no fee at all");
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(escrow.getWarrant(ID).status), uint8(WarrantEscrow.Status.Reclaimed));
    }

    /// @dev I9 — the reverse order within the block changes nothing: after `reclaim`,
    ///      `slash` fails on `NotOpen` instead of `Expired`. Both paths are closed.
    function test_I9_FrontRunScenario_ReverseOrder() public {
        _openFunded(ID, BOND, DURATION);
        vm.warp(escrow.getWarrant(ID).expiry + 1);

        vm.prank(stranger);
        escrow.reclaim(ID);

        vm.prank(settler);
        vm.expectRevert(WarrantEscrow.NotOpen.selector);
        escrow.slash(ID, EXEC_REF, "hostile slash");

        assertEq(usdc.balanceOf(agent), BOND);
    }

    /// @dev `MIN_DURATION` must be enough for a full L1 cycle: execution + 12 confirmations
    ///      (~12 s per block, so 144 s) must leave a strictly positive settlement margin
    ///      before `expiry`.
    function test_I9_MinDurationCoversFullL1Cycle() public {
        uint64 minDuration = escrow.MIN_DURATION();
        _openFunded(ID, BOND, minDuration);
        uint64 expiry = escrow.getWarrant(ID).expiry;

        uint256 executionDelay = 30; // submission + inclusion of the transaction
        uint256 confirmations = 12; // R2: 12 confirmations on L1
        uint256 blockTime = 12;
        uint256 evaluation = 15; // RPC read + evaluation by the checkers
        uint256 elapsed = executionDelay + confirmations * blockTime + evaluation; // 189 s

        vm.warp(block.timestamp + elapsed);
        assertLt(block.timestamp, expiry, "strictly positive settlement margin");
        assertGt(uint256(expiry) - block.timestamp, 0);
        assertEq(uint256(expiry) - block.timestamp, uint256(minDuration) - elapsed); // 711 s

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF); // settlement still goes through with room to spare
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

        // The former opener is no longer allowed to open.
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

    /// @dev I10 — rotation can no longer merge the two roles. Without that guard,
    ///      the owner would rebuild by rotation exactly the configuration the
    ///      constructor forbids.
    function test_SetOpener_RevertsWhenItWouldMergeRoles() public {
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        escrow.setOpener(settler);
        assertEq(escrow.opener(), opener, "rotation refused, state unchanged");
    }

    function test_SetSettler_RevertsWhenItWouldMergeRoles() public {
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        escrow.setSettler(opener);
        assertEq(escrow.settler(), settler, "rotation refused, state unchanged");
    }

    /// @dev I4 — the commitment is immutable: no function rewrites the hashes.
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
        // The frozen rate is now part of that immutable commitment.
        assertEq(afterState.feeBpsAtOpen, before.feeBpsAtOpen);
    }

    /// @dev I8 under fuzzing: exact conservation across the whole range of bonds and fees.
    function testFuzz_Honor_ConservesValue(uint256 bond, uint16 fee) public {
        bond = bound(bond, 1, 1e15); // up to one billion USDC
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

    /// @dev I1 under fuzzing. The property is unchanged — the contract never
    ///      promises more than it holds — but the mechanism has: underfunding is
    ///      arbitrated by the token, and on success the balance is exactly equal
    ///      to `totalLocked`, no longer merely greater than or equal.
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
            assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked(), "exact funding");
        }
    }

    /// @dev I9 under fuzzing: across the whole time range, the boundary is exactly `>`.
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
            // ...and the permissionless refund is then still open (I5).
            escrow.reclaim(ID);
            assertEq(usdc.balanceOf(agent), BOND);
        } else {
            escrow.slash(ID, EXEC_REF, "violation");
            assertEq(usdc.balanceOf(beneficiary), BOND);
        }
    }
}
