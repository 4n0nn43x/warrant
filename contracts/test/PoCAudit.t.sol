// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {AuthSigner} from "./helpers/AuthSigner.sol";

/// @title PoCs for the audit fixes — every test proves that an attack FAILS
/// @notice One test per fix. These are not unit tests: they are attack scenarios,
///         played from the attacker's point of view, shown to produce nothing at
///         all any more. Each one emits the figures that settle the matter — the
///         attacker's gain, the amount the victim recovers, the unattached balance
///         up for grabs, the lock-up avoided — because an `expectRevert` on its own
///         does not say what the attacker *walked away with*.
/// @dev    References: `audit/findings/01-i10-non-applique.md` and
///         `audit/findings/02-opener-autorite-de-retrait.md`.
contract PoCAuditTest is AuthSigner {
    WarrantEscrow internal escrow;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal beneficiary = makeAddr("beneficiary");

    /// @dev The attacker IS the opener: the KeeperHub wallet, which
    ///      `docs/transactions.md` § 3 describes as shared organisation-wide. It
    ///      carries a key, so that it can try to sign authorizations itself.
    address internal opener;
    uint256 internal openerKey;

    address internal settler;
    address internal victim; // the agent who actually pays the bond
    uint256 internal victimKey;
    address internal stranger = makeAddr("stranger");

    uint16 internal constant FEE_BPS = 250; // 2.5 %
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
        (opener, openerKey) = makeAddrAndKey("hostile-opener");
        settler = makeAddr("settler");
        (victim, victimKey) = makeAddrAndKey("victim");

        usdc = new MockUSDC();
        vm.prank(owner);
        escrow = new WarrantEscrow(address(usdc), treasury, opener, settler, FEE_BPS);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /// @dev An arbitrary nonce, for the cases where the expected refusal lands
    ///      BEFORE the terms check and nonce conformity is therefore irrelevant.
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

    /// @dev The standard terms, the ones the victim actually agrees to.
    function _standardTerms() internal view returns (Terms memory) {
        return _terms(ID, beneficiary, BOND, DURATION);
    }

    /// @dev The victim's legitimate authorization for those exact terms.
    function _victimAuth(Terms memory t) internal view returns (WarrantEscrow.Authorization memory) {
        return _authForTerms(escrow, usdc, victim, victimKey, t);
    }

    /// @dev The contract's balance that backs no open warrant. This was the exact
    ///      bound on the theft described by finding 02: "balanceOf(escrow) −
    ///      totalLocked at the instant of the open". Every PoC measures it.
    function _freeBalance() internal view returns (uint256) {
        return usdc.balanceOf(address(escrow)) - escrow.totalLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 1 — I10: the two roles can no longer be a single key
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Finding 01. I10 was declared in the documentation, tested by a
    ///         tautology, and enforced only by a deployment script that nothing
    ///         compels anyone to use. It is now a guard in the contract, at all
    ///         three places where the configuration can be born or change.
    function test_PoC1_I10_ConstructorAndBothRotationsRefuseMergedRoles() public {
        uint256 refusals;

        // (a) Birth: the constructor refuses the merged configuration.
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        new WarrantEscrow(address(usdc), treasury, opener, opener, FEE_BPS);
        ++refusals;

        // (b) Rotating the opener onto the current settler.
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        escrow.setOpener(settler);
        ++refusals;

        // (c) Rotating the settler onto the current opener.
        vm.prank(owner);
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        escrow.setSettler(opener);
        ++refusals;

        // State has not budged an inch: none of the three routes half-succeeds.
        assertEq(escrow.opener(), opener);
        assertEq(escrow.settler(), settler);
        assertTrue(escrow.opener() != escrow.settler());

        emit log_named_uint("PoC1 - merge attempts refused", refusals);
        emit log_named_uint("PoC1 - merges that succeeded", 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 2 — the opener's withdrawal authority (the central PoC)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Finding 02, high severity. Before the fix, the opener freely named
    ///         the `agent` — recipient of both `honor` and `reclaim` — with no
    ///         verified link to the payer whatsoever, and the funding check was
    ///         purely aggregate: anybody's money satisfied it. An opener acting
    ///         alone, with no collusion and no capital, pocketed any unattached
    ///         balance through `reclaim` once `MIN_DURATION` had elapsed.
    ///
    ///         This PoC closes all five routes, in the order an attacker would try
    ///         them, and measures the gain at each step.
    function test_PoC2_HostileOpenerCannotAppropriateAnyonesFunds() public {
        // The victim holds its bond and signs an authorization backed by precise
        // terms: this is the content of the x402 `exact` payload, which the opener
        // sees go past by construction — it is the Gateway.
        usdc.mint(victim, BOND);
        Terms memory t = _standardTerms();
        WarrantEscrow.Authorization memory victimAuth = _victimAuth(t);

        // ── Route 1: forge an authorization in the victim's name.
        // The attacker knows its address and the terms, but not its key.
        WarrantEscrow.Authorization memory forged = _authForTerms(escrow, usdc, victim, openerKey, t);
        vm.prank(opener);
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, forged);

        // ── Route 2: declare oneself the agent.
        // Not even expressible: `agent` is no longer a parameter. The only way to
        // be the agent is to sign — hence to pay. The attacker does sign, but has
        // not a cent to its name: the token refuses to debit it.
        WarrantEscrow.Authorization memory selfAuth = _authForTerms(escrow, usdc, opener, openerKey, t);
        assertEq(usdc.balanceOf(opener), 0, "the attacker brings no capital");
        vm.prank(opener);
        vm.expectRevert(MockUSDC.InsufficientBalance.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, selfAuth);

        // ── Route 3: divert the legitimate authorization towards other terms, and
        // name oneself the beneficiary. This was the residue the first fix left
        // open: the signature proved who paid, not what had been agreed to. Now
        // that the nonce hashes the terms, the substitution is caught by the
        // contract.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, opener, BOND, CONDITION_HASH, ACTION_HASH, DURATION, victimAuth);

        // ── Route 4: fall back on the signed terms, exactly as they stand. The
        // opening succeeds — that is the normal path — but the `agent` is the
        // VICTIM, proven by its signature, and the beneficiary is the one it
        // agreed to. `slash` belongs to the settler, a key I10 keeps distinct.
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, victimAuth);
        assertEq(escrow.getWarrant(ID).agent, victim, "the agent is the signer, not the opener");
        assertEq(escrow.getWarrant(ID).beneficiary, beneficiary, "the beneficiary is the one that was signed");

        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.slash(ID, EXEC_REF, "self-award");
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.NotSettler.selector);
        escrow.honor(ID, EXEC_REF);

        // ── Route 5: wait for expiry and trigger `reclaim`, which stays
        // permissionless. This was the coup de grâce of the original attack. The
        // refund now goes to the *proven* agent: the victim.
        vm.warp(escrow.getWarrant(ID).expiry + 1);
        vm.prank(opener);
        escrow.reclaim(ID);

        uint256 attackerGain = usdc.balanceOf(opener);
        uint256 victimRecovered = usdc.balanceOf(victim);

        emit log_named_uint("PoC2 - the victim's bond (uUSDC)", BOND);
        emit log_named_uint("PoC2 - hostile opener's gain (uUSDC)", attackerGain);
        emit log_named_uint("PoC2 - recovered by the victim (uUSDC)", victimRecovered);
        emit log_named_uint("PoC2 - unattached balance up for grabs (uUSDC)", _freeBalance());
        emit log_named_uint("PoC2 - attack routes closed", 5);

        assertEq(attackerGain, 0, "the opener recovers nothing");
        assertEq(victimRecovered, BOND, "the victim recovers the whole bond");
        assertEq(usdc.balanceOf(treasury), 0, "no fee on a reclaim");
        assertEq(_freeBalance(), 0, "no unattached balance to capture");
    }

    /// @notice The second half of finding 02: the *window* of unattached balance.
    ///         The old attack was bounded by `balanceOf(escrow) − totalLocked` at
    ///         the instant of the `open`, and that quantity was non-zero by
    ///         construction — every x402 settlement passed through the contract's
    ///         balance before its opening. Now that funding is atomic, the quantity
    ///         is identically zero at every stage of a warrant's life cycle. The
    ///         bound on the theft is therefore zero, and not merely "hard to
    ///         reach".
    function test_PoC2b_NoFreeBalanceWindowExistsAnymore() public {
        assertEq(_freeBalance(), 0, "before any warrant at all");

        usdc.mint(victim, 2 * BOND);
        WarrantEscrow.Authorization memory a1 = _victimAuth(_standardTerms());
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, a1);
        assertEq(_freeBalance(), 0, "right after an opening");

        WarrantEscrow.Authorization memory a2 = _victimAuth(_terms(ID2, beneficiary, BOND, DURATION));
        vm.prank(opener);
        escrow.open(ID2, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, a2);
        assertEq(_freeBalance(), 0, "with two concurrent warrants");

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);
        assertEq(_freeBalance(), 0, "after a settlement");

        vm.warp(escrow.getWarrant(ID2).expiry + 1);
        escrow.reclaim(ID2);
        assertEq(_freeBalance(), 0, "after a refund");
        assertEq(usdc.balanceOf(address(escrow)), 0, "the contract holds nothing back");

        emit log_named_uint("PoC2b - highest unattached balance observed (uUSDC)", 0);
        emit log_named_uint("PoC2b - bound on the theft of finding 02 (uUSDC)", 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 3 — anti-replay, in three layers
    // ─────────────────────────────────────────────────────────────────────

    /// @notice One authorization funds one warrant and no more. Now that the nonce
    ///         equals `termsHash(terms)`, `id` included, the protection has gone
    ///         from one layer to three, and the first two live in the contract:
    ///           (a) different terms → `TermsMismatch`;
    ///           (b) same terms → `AlreadyExists`, the identifier is spent;
    ///           (c) and the token's historical layer still bites, which part (c)
    ///               demonstrates on a SECOND escrow — an EIP-3009 `nonce` is
    ///               global per authorizer, not per counterparty.
    function test_PoC3_ReplayingTheSameAuthorizationReverts() public {
        // Balance deliberately set at TWICE the bond: were a replay to fail for
        // want of funds, the PoC would prove nothing about the replay itself.
        usdc.mint(victim, 2 * BOND);
        Terms memory t = _standardTerms();
        bytes32 nonce = _termsNonce(escrow, t);
        WarrantEscrow.Authorization memory auth = _victimAuth(t);

        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
        assertTrue(usdc.authorizationState(victim, nonce), "nonce spent, on the token's books");
        assertEq(escrow.getWarrant(ID).fundingRef, nonce, "fundingRef == nonce == termsHash");

        // (a) The "terms" layer: the authorization does not designate that warrant.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID2, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // (b) The "identifier" layer: the terms match, but the id is taken.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.AlreadyExists.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // (c) The "token" layer. `termsHash` is `pure`: a second escrow backed by
        // the same USDC derives EXACTLY the same nonce for the same terms. Both
        // previous checks therefore let it through — and it is the token that
        // refuses, because an EIP-3009 nonce is unique per authorizer, all
        // counterparties taken together. Without that layer, the same commitment
        // would be fundable once per deployed escrow.
        vm.prank(owner);
        WarrantEscrow escrow2 = new WarrantEscrow(address(usdc), treasury, opener, settler, FEE_BPS);
        assertEq(escrow2.termsHash(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION), nonce);
        WarrantEscrow.Authorization memory auth2 = _authForTerms(escrow2, usdc, victim, victimKey, t);
        vm.prank(opener);
        vm.expectRevert(MockUSDC.AuthorizationUsed.selector);
        escrow2.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth2);

        emit log_named_uint("PoC3 - the victim's balance before (uUSDC)", 2 * BOND);
        emit log_named_uint("PoC3 - debited exactly once (uUSDC)", 2 * BOND - usdc.balanceOf(victim));
        emit log_named_uint("PoC3 - warrants funded by this authorization", 1);
        emit log_named_uint("PoC3 - anti-replay protection layers", 3);
        assertEq(usdc.balanceOf(victim), BOND, "a single debit");
        assertEq(escrow.totalLocked(), BOND, "a single warrant");
        assertEq(escrow2.totalLocked(), 0, "nothing on the second escrow");
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 4 — anti-interception
    // ─────────────────────────────────────────────────────────────────────

    /// @notice `receiveWithAuthorization` and not `transferWithAuthorization`: the
    ///         `receive` variant enforces `to == msg.sender`. Without it, anyone
    ///         could submit the intercepted authorization straight to the token —
    ///         the funds would indeed land on the escrow, but the nonce would be
    ///         spent and the legitimate `open` would revert. We would have traded a
    ///         theft for a denial of service that recreates the orphaned-funds
    ///         problem: paid, with no warrant, and with no recourse.
    function test_PoC4_ThirdPartyCannotSubmitTheAuthorizationToTheToken() public {
        usdc.mint(victim, BOND);
        Terms memory t = _standardTerms();
        bytes32 nonce = _termsNonce(escrow, t);
        WarrantEscrow.Authorization memory auth = _victimAuth(t);

        // (a) The third party submits the authorization as it stands, `to` = the
        // escrow. `to != msg.sender`: refused before the signature is even looked at.
        vm.prank(stranger);
        vm.expectRevert(MockUSDC.CallerMustBePayee.selector);
        usdc.receiveWithAuthorization(
            victim, address(escrow), BOND, VALID_AFTER, VALID_BEFORE, nonce, auth.v, auth.r, auth.s
        );

        // (b) The third party puts itself in `to` to satisfy that check. The digest
        // then changes, and the victim's signature no longer covers it.
        vm.prank(stranger);
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.receiveWithAuthorization(
            victim, stranger, BOND, VALID_AFTER, VALID_BEFORE, nonce, auth.v, auth.r, auth.s
        );

        // The nonce is untouched: the legitimate authorization still goes through.
        // That is the point that separates a real fix from a denial of service.
        assertFalse(usdc.authorizationState(victim, nonce), "nonce not spent");
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        emit log_named_uint("PoC4 - interceptions that succeeded", 0);
        emit log_named_uint("PoC4 - diverted by the third party (uUSDC)", usdc.balanceOf(stranger));
        emit log_named_uint("PoC4 - collected by the escrow (uUSDC)", usdc.balanceOf(address(escrow)));
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(address(escrow)), BOND);
        assertEq(escrow.getWarrant(ID).agent, victim);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 5 — `beneficiary == treasury` refused
    // ─────────────────────────────────────────────────────────────────────

    /// @notice I6 ("a slash takes no fee") was a property of the code paths:
    ///         `slash` simply never called the treasury. But an opener could name
    ///         the treasury as beneficiary, and a slash then paid it 100 % of the
    ///         bond — I6 stayed true to the letter and false in its intent. The
    ///         guard makes it true by construction: the forbidden state becomes
    ///         unreachable.
    /// @dev    The authorization here **conforms** to terms that name the treasury:
    ///         the only possible ground for refusal is therefore
    ///         `BeneficiaryIsTreasury`, and not a badly derived nonce. Not even the
    ///         victim can consent to that configuration.
    function test_PoC5_BeneficiaryCannotBeTheTreasury() public {
        usdc.mint(victim, 2 * BOND);
        WarrantEscrow.Authorization memory toTreasury = _victimAuth(_terms(ID, treasury, BOND, DURATION));

        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.BeneficiaryIsTreasury.selector);
        escrow.open(ID, treasury, BOND, CONDITION_HASH, ACTION_HASH, DURATION, toTreasury);

        // Counter-proof: with a regular beneficiary the whole path works, and the
        // treasury still receives nothing at all on a slash.
        WarrantEscrow.Authorization memory regular = _victimAuth(_standardTerms());
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, regular);
        vm.prank(settler);
        escrow.slash(ID, EXEC_REF, "post-condition breached");

        emit log_named_uint("PoC5 - paid to the treasury on a slash (uUSDC)", usdc.balanceOf(treasury));
        emit log_named_uint("PoC5 - paid to the beneficiary (uUSDC)", usdc.balanceOf(beneficiary));
        assertEq(usdc.balanceOf(treasury), 0, "I6 true by construction");
        assertEq(usdc.balanceOf(beneficiary), BOND);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 6 — fee frozen at open time
    // ─────────────────────────────────────────────────────────────────────

    /// @notice The owner could double `feeBps` between a warrant's opening and its
    ///         settlement, and levy the new rate on a bond already committed. The
    ///         agent was committing to economic terms its counterparty could then
    ///         change unilaterally after the fact. `feeBpsAtOpen` freezes them.
    function test_PoC6_FeeIsFrozenAtOpenTime() public {
        usdc.mint(victim, BOND);
        WarrantEscrow.Authorization memory auth = _victimAuth(_standardTerms());

        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);
        assertEq(escrow.getWarrant(ID).feeBpsAtOpen, 250, "opened at 250 bps");

        // The owner doubles the rate, right up to the cap, while the warrant is open.
        vm.prank(owner);
        escrow.setFeeBps(500);
        assertEq(escrow.feeBps(), 500, "current rate doubled");

        vm.prank(settler);
        escrow.honor(ID, EXEC_REF);

        uint256 feeAt250 = (BOND * 250) / 10_000; // 2 500 000 = 2.5 USDC
        uint256 feeAt500 = (BOND * 500) / 10_000; // 5 000 000 = 5.0 USDC

        emit log_named_uint("PoC6 - rate at open (bps)", 250);
        emit log_named_uint("PoC6 - current rate at settlement (bps)", 500);
        emit log_named_uint("PoC6 - fee actually taken (uUSDC)", usdc.balanceOf(treasury));
        emit log_named_uint("PoC6 - fee if the current rate applied (uUSDC)", feeAt500);
        emit log_named_uint("PoC6 - refunded to the agent (uUSDC)", usdc.balanceOf(victim));
        emit log_named_uint("PoC6 - overcharge avoided (uUSDC)", feeAt500 - feeAt250);

        assertEq(usdc.balanceOf(treasury), feeAt250, "fee at the frozen rate");
        assertEq(usdc.balanceOf(victim), BOND - feeAt250, "97.5 USDC, not 95");
        assertEq(usdc.balanceOf(victim), 97_500_000);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 7 — `ValueMismatch`
    // ─────────────────────────────────────────────────────────────────────

    /// @notice `auth.value` must equal `bond` EXACTLY, in both directions. A
    ///         surplus would be unrecoverable — the contract has no sweep function
    ///         — and a shortfall would leave the contract carrying a commitment it
    ///         does not hold, breaking I1 the moment a token accepted a partial
    ///         transfer.
    /// @dev    Each authorization conforms to ITS OWN terms; what diverges is the
    ///         `bond` declared in the call. `ValueMismatch` applies upstream of the
    ///         terms check, so it really is that guard we isolate here.
    function test_PoC7_ValueMustMatchBondExactly() public {
        usdc.mint(victim, 10 * BOND); // ample balance: the refusal does not come from there

        // Direction 1: the authorization carries more than the declared bond. The
        // excess would stay stuck on the contract forever.
        WarrantEscrow.Authorization memory tooMuch = _victimAuth(_terms(ID, beneficiary, BOND + 1, DURATION));
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ValueMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, tooMuch);

        // Direction 2: the authorization carries less than the declared bond. The
        // contract would commit to `BOND` while only collecting `BOND - 1`.
        WarrantEscrow.Authorization memory tooLittle =
            _victimAuth(_terms(ID, beneficiary, BOND - 1, DURATION));
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.ValueMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, tooLittle);

        // The exact case goes through, and the funding is right to the cent.
        WarrantEscrow.Authorization memory exact = _victimAuth(_standardTerms());
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, exact);

        emit log_named_uint("PoC7 - declared bond (uUSDC)", BOND);
        emit log_named_uint("PoC7 - refused at bond+1 (uUSDC)", BOND + 1);
        emit log_named_uint("PoC7 - refused at bond-1 (uUSDC)", BOND - 1);
        emit log_named_uint("PoC7 - collected by the escrow (uUSDC)", usdc.balanceOf(address(escrow)));
        emit log_named_uint("PoC7 - committed (totalLocked, uUSDC)", escrow.totalLocked());
        emit log_named_uint("PoC7 - unrecoverable surplus (uUSDC)", _freeBalance());

        assertEq(usdc.balanceOf(address(escrow)), BOND);
        assertEq(escrow.totalLocked(), BOND);
        assertEq(_freeBalance(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 8 — beneficiary substitution (binding of the terms)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice The residue the first fix left open. The EIP-3009 digest only covers
    ///         `(from, to, value, validAfter, validBefore, nonce)`: the agent proved
    ///         that it paid, while saying nothing about what it was backing with
    ///         that payment. The `opener` could therefore take an authorization
    ///         meant for one warrant and use it for another, whose beneficiary it
    ///         chose — an accomplice. With a complicit `settler`, an immediate
    ///         `slash` paid out 100 % of the bond, fee-free: I10 took the attack
    ///         from one key to two, it did not close it.
    ///
    ///         Now that the nonce hashes the terms, `beneficiary` is covered by the
    ///         agent's signature.
    function test_PoC8_OpenerCannotSubstituteTheBeneficiary() public {
        usdc.mint(victim, BOND);
        Terms memory agreed = _standardTerms(); // beneficiary agreed to: `beneficiary`
        WarrantEscrow.Authorization memory auth = _victimAuth(agreed);
        address accomplice = makeAddr("settler-accomplice");

        // Substitution towards an accomplice.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, accomplice, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Substitution towards the opener itself.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, opener, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // Nothing moved, and the agreed terms remain openable.
        assertEq(escrow.totalLocked(), 0, "no warrant was diverted");
        assertEq(usdc.balanceOf(victim), BOND, "the victim was not debited");
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, DURATION, auth);

        // And even with a complicit settler, the slash can only go to the signed
        // beneficiary: the divertible amount is zero.
        vm.prank(settler);
        escrow.slash(ID, EXEC_REF, "complicit settler");

        emit log_named_uint("PoC8 - bond at stake (uUSDC)", BOND);
        emit log_named_uint("PoC8 - beneficiary substitutions that succeeded", 0);
        emit log_named_uint("PoC8 - received by the accomplice (uUSDC)", usdc.balanceOf(accomplice));
        emit log_named_uint("PoC8 - received by the opener (uUSDC)", usdc.balanceOf(opener));
        emit log_named_uint("PoC8 - received by the signed beneficiary (uUSDC)", usdc.balanceOf(beneficiary));
        emit log_named_uint("PoC8 - divertible even with opener+settler collusion (uUSDC)", 0);

        assertEq(usdc.balanceOf(accomplice), 0);
        assertEq(usdc.balanceOf(opener), 0);
        assertEq(usdc.balanceOf(beneficiary), BOND, "the whole bond to the signed beneficiary");
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoC 9 — duration substitution (lock-up without consent)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice The other way of exploiting the same residue, and the most insidious
    ///         one because it demands **no collusion and no capital**: the `opener`
    ///         alone would take an authorization meant for a `MIN_DURATION` warrant
    ///         and open a `MAX_DURATION` one. Nothing was stolen — `reclaim` did
    ///         eventually refund — but the bond stayed locked up for 7 days instead
    ///         of 15 minutes: a denial of service on the agent's capital, free for
    ///         the attacker and repeatable on every single payment.
    function test_PoC9_OpenerCannotStretchTheLockupDuration() public {
        uint64 minDuration = escrow.MIN_DURATION(); // 900 s
        uint64 maxDuration = escrow.MAX_DURATION(); // 604 800 s
        usdc.mint(victim, BOND);

        // The victim agrees to the minimum duration and nothing more.
        Terms memory agreed = _terms(ID, beneficiary, BOND, minDuration);
        WarrantEscrow.Authorization memory auth = _victimAuth(agreed);

        // The opener attempts the maximal stretch.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, maxDuration, auth);

        // And even a stretch of a single second is refused: the bound is not
        // "reasonable", it is exact.
        vm.prank(opener);
        vm.expectRevert(WarrantEscrow.TermsMismatch.selector);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, minDuration + 1, auth);

        // The signed duration, on the other hand, opens.
        vm.prank(opener);
        escrow.open(ID, beneficiary, BOND, CONDITION_HASH, ACTION_HASH, minDuration, auth);

        uint64 actualLockup = escrow.getWarrant(ID).expiry - escrow.getWarrant(ID).openedAt;

        emit log_named_uint("PoC9 - duration agreed to by the agent (s)", minDuration);
        emit log_named_uint("PoC9 - the warrant's effective duration (s)", actualLockup);
        emit log_named_uint("PoC9 - duration the opener wanted to impose (s)", maxDuration);
        emit log_named_uint("PoC9 - lock-up avoided (s)", maxDuration - minDuration);
        emit log_named_uint("PoC9 - stretch factor avoided", maxDuration / minDuration);
        emit log_named_uint("PoC9 - capital locked up in excess (uUSDC)", 0);

        assertEq(actualLockup, minDuration, "the duration is the one that was signed");
        assertEq(maxDuration / minDuration, 672, "7 days against 15 minutes");

        // End-to-end check: the bond really is reclaimable after 15 minutes, and
        // not after 7 days.
        vm.warp(uint256(escrow.getWarrant(ID).expiry) + 1);
        escrow.reclaim(ID);
        assertEq(usdc.balanceOf(victim), BOND, "refunded after 900 s, not 604 800");
    }
}
