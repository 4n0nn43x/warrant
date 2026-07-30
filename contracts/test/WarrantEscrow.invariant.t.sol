// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {AuthSigner} from "./helpers/AuthSigner.sol";

/// @title Stateful fuzzing handler for `WarrantEscrow`
/// @notice Every transition goes through here. The handler asserts nothing: it records
///         ghost variables, and the assertions live in the `invariant_` functions.
///         (An assertion failing inside a handler would be swallowed by `fail_on_revert = false`.)
/// @dev    Post-audit migration: funding a warrant has become a signed EIP-3009
///         authorization. The actors therefore stop being inert addresses to
///         become accounts that carry keys — with no key, the handler can no
///         longer open a single warrant and the whole campaign would spin on an
///         empty set.
contract WarrantHandler is AuthSigner {
    WarrantEscrow public immutable escrow;
    MockUSDC public immutable usdc;

    address public immutable owner;
    address public immutable treasury;

    /// @dev A pool SHARED by both roles — see the constructor.
    address[3] public openerPool;
    address[3] public settlerPool;
    /// @dev Actors (agents / beneficiaries). Excludes treasury, owner, opener, settler:
    ///      the per-address ghost accounting has to stay unambiguous.
    address[4] public actors;
    /// @dev The actors' private keys, indexed like `actors`. They are what makes it
    ///      possible to produce the EIP-3009 authorization without which `open` no
    ///      longer goes through.
    uint256[4] public actorKeys;

    bytes32[] public ids;

    /// @dev Monotonic counter. It serves both as identifier uniqueness and as
    ///      EIP-3009 nonce uniqueness: the token refuses the same nonce twice for
    ///      the same authorizer, and a recycled nonce would make every subsequent
    ///      `open` by that agent revert — the campaign would test nothing at all,
    ///      with nothing to signal it.
    uint256 public authSeq;

    // ── Ghost variables ───────────────────────────────────────────────────
    mapping(address => uint256) public ghostExpectedBalance; // I8 — conservation
    mapping(bytes32 => uint256) public ghostExits; // I2 — exits from `Open`
    mapping(bytes32 => bytes32) public ghostConditionHash; // I4
    mapping(bytes32 => bytes32) public ghostActionHash; // I4
    mapping(bytes32 => uint256) public ghostBond; // I4
    mapping(bytes32 => address) public ghostAgent;
    mapping(bytes32 => uint8) public ghostFinalStatus; // I3 — 0 = still Open
    uint256 public ghostFeesFromSlash; // I6 — must stay at 0
    uint256 public ghostFeesFromHonor;
    uint256 public ghostSumOpenBonds; // I1 — cross-check of totalLocked

    uint256 public callsOpen;
    uint256 public callsHonor;
    uint256 public callsSlash;
    uint256 public callsReclaim;

    /// @dev Attempts to divert the terms, and those that SUCCEEDED. The second
    ///      must stay at zero. Without those two counters,
    ///      `invariant_I4_FundingRefBindsTheTerms` would be the fourth incarnation
    ///      of the audit's trap: since the handler only ever signs conforming
    ///      terms, the binding would be true by construction of the harness and
    ///      the invariant would pass even with the contract's guard removed.
    uint256 public callsSubstitutionAttempted;
    uint256 public callsSubstitutionAccepted;

    constructor(WarrantEscrow escrow_, MockUSDC usdc_, address owner_, address treasury_) {
        escrow = escrow_;
        usdc = usdc_;
        owner = owner_;
        treasury = treasury_;

        // A SHARED pool, and that is the whole point. With two disjoint pools —
        // which is what used to be here — the fuzzer simply COULD NOT produce
        // `opener == settler`, and `assertTrue(opener != settler)` passed 16,384
        // times without ever testing anything. The invariant certified a property
        // that the harness itself imposed, never the contract.
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

    /// @dev An opening now carries its own funding: the handler credits the AGENT,
    ///      then has the authorization signed. We deliberately underfund one time
    ///      in four — the failure path is no longer `Underfunded` (the contract no
    ///      longer observes a balance, it pulls the payment) but the token's
    ///      refusal for want of balance on the agent's side. That path must keep
    ///      being exercised: it is the only way an opening can fail *after* all of
    ///      the contract's checks have been cleared.
    ///
    ///      Splitting `_plan` / `_tryOpen` around a `Terms` struct in memory is not
    ///      cosmetic: with the six components of the terms, the agent, its key, the
    ///      funding and the signed authorization, the compiler bailed out with
    ///      "stack too deep" without `via_ir`.
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
        // `id` derived from a monotonic counter: since the EIP-3009 nonce is now
        // `termsHash(terms)`, and `id` is part of the terms, `id` alone is what
        // guarantees nonce uniqueness. A recycled `id` would produce an
        // already-spent nonce and make every opening revert — an empty campaign.
        t.id = keccak256(abi.encode("warrant", ++authSeq));
        // Beneficiary NECESSARILY distinct from the agent: `open` now reverts on
        // `BadBeneficiary` when the two coincide. Drawing freely from the pool
        // would fail one opening in four for an uninteresting reason and would cut
        // the campaign's useful depth by just as much — exactly the trap
        // `invariant_I10` had fallen into, only the other way round.
        // `+ 1 + (seed % (n-1))` covers the other n−1 indices, never `ai`.
        t.beneficiary = actors[(ai + 1 + (beneficiarySeed % (actors.length - 1))) % actors.length];
        t.bond = _bound(bondSeed, 1, 1_000_000e6);
        t.conditionHash = keccak256(abi.encode("condition", t.id));
        t.actionHash = keccak256(abi.encode("action", t.id));
        // Bounds deliberately overshooting: `BadDuration` must be exercised too.
        t.duration = uint64(_bound(durationSeed, 0, uint256(escrow.MAX_DURATION()) + 1 days));
    }

    function _tryOpen(uint256 ai, Terms memory t, uint256 fundSeed) internal {
        address agent = actors[ai];

        uint256 funding = fundSeed % 4 == 0 ? t.bond / 2 : t.bond;
        if (funding > 0) {
            usdc.mint(agent, funding);
            // Accounted for outside the `try`: if the opening fails, the agent keeps
            // those funds, and I8 must still add up.
            ghostExpectedBalance[agent] += funding;
        }

        // Nonce = `termsHash(terms)`, obtained from the contract itself. Recomputing
        // it here would amount to comparing a copy of the formula against itself.
        WarrantEscrow.Authorization memory auth = _authForTerms(escrow, usdc, agent, actorKeys[ai], t);

        // One time in seven, the `opener` plays the attacker: it keeps the
        // authorization signed for `t.beneficiary` and opens the warrant in favour
        // of a THIRD PARTY. That is exactly the diversion the latest fix closes,
        // and it is what gives `invariant_I4_FundingRefBindsTheTerms` its teeth: if
        // the guard vanished, those openings would succeed and would store a
        // `fundingRef` that does not hash the warrant's actual terms. The rate is
        // kept moderate so as not to cut the campaign's useful depth — these calls
        // are bound to revert.
        address declared = t.beneficiary;
        if (fundSeed % 7 == 0) {
            declared = _otherActor(agent, t.beneficiary);
            ++callsSubstitutionAttempted;
        }

        vm.prank(escrow.opener());
        try escrow.open(t.id, declared, t.bond, t.conditionHash, t.actionHash, t.duration, auth) {
            ghostExpectedBalance[agent] -= t.bond; // the bond really did leave the agent
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

    /// @dev An actor distinct from both `agent` and `signed`: the substituted
    ///      beneficiary must clear every guard placed BEFORE the terms check
    ///      (non-zero, not the treasury, not the agent, not the contract), otherwise
    ///      the refusal would come from elsewhere and prove nothing about the binding.
    function _otherActor(address agent, address signed) internal view returns (address) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] != agent && actors[i] != signed) return actors[i];
        }
        return signed; // unreachable with four distinct actors
    }

    function honor(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        WarrantEscrow.Warrant memory w = escrow.getWarrant(id);

        // The rate frozen at open, not the current one: `setFeeBps` may have moved
        // in the meantime, and that is precisely what the fix neutralises.
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
        try escrow.slash(id, keccak256(abi.encode("exec", id)), "post-condition breached") {
            ghostExpectedBalance[w.beneficiary] += w.bond;
            // I6: the treasury must not move by a single unit on a slash.
            ghostFeesFromSlash += usdc.balanceOf(treasury) - treasuryBefore;
            ghostSumOpenBonds -= w.bond;
            ghostExits[id] += 1;
            ghostFinalStatus[id] = uint8(WarrantEscrow.Status.Slashed);
            ++callsSlash;
        } catch {}
    }

    /// @dev Permissionless: the caller is an arbitrary third party.
    function reclaim(uint256 idSeed, uint256 callerSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        WarrantEscrow.Warrant memory w = escrow.getWarrant(id);

        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(address(uint160(uint256(keccak256(abi.encode("caller", callerSeed))))));
        try escrow.reclaim(id) {
            ghostExpectedBalance[w.agent] += w.bond; // refunded in full, no fee
            ghostFeesFromSlash += usdc.balanceOf(treasury) - treasuryBefore;
            ghostSumOpenBonds -= w.bond;
            ghostExits[id] += 1;
            ghostFinalStatus[id] = uint8(WarrantEscrow.Status.Reclaimed);
            ++callsReclaim;
        } catch {}
    }

    /// @dev Pushes time forward so that warrants really do expire.
    function warp(uint256 seed) external {
        vm.warp(block.timestamp + _bound(seed, 1, 3 days));
    }

    function setFeeBps(uint256 seed) external {
        vm.prank(owner);
        try escrow.setFeeBps(uint16(_bound(seed, 0, 1_000))) {} catch {} // > MAX_FEE_BPS reverts
    }

    /// @dev The fuzzer draws from a SHARED pool, so it regularly tries to merge
    ///      the two roles. The contract must refuse: that is the `RolesMustDiffer`
    ///      guard. We swallow the revert so the campaign carries on, and
    ///      `invariant_I10` then checks that the merge did not happen. Removing the
    ///      guard from the contract must make `invariant_I10` FAIL — that is the
    ///      test of the test, and the whole reason the pool is shared.
    function rotateRoles(uint256 openerSeed, uint256 settlerSeed) external {
        vm.startPrank(owner);
        try escrow.setOpener(openerPool[openerSeed % openerPool.length]) {} catch {}
        try escrow.setSettler(settlerPool[settlerSeed % settlerPool.length]) {} catch {}
        vm.stopPrank();
    }

    /// @dev Unsolicited USDC donations: they must never break the accounting. Now
    ///      that funding is atomic and exact, this is the ONLY possible source of
    ///      surplus on the contract — hence the only way of keeping I1 meaningful
    ///      as an inequality (`>=`) rather than a trivial equality.
    function donate(uint256 seed) external {
        usdc.mint(address(escrow), _bound(seed, 1, 1_000e6));
    }
}

/// @title Invariants I1–I10 of `WarrantEscrow` under stateful fuzzing
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

        // Nobody else must be called directly by the fuzzer.
        excludeContract(address(escrow));
        excludeContract(address(usdc));
    }

    /// @dev Compares the error selector returned by a low-level call.
    function _assertRevertsWith(bytes memory err, bytes4 expected, string memory context) internal pure {
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 got = bytes32(err);
        assertEq(got, bytes32(expected), context);
    }

    /// @dev A dummy authorization, never valid. It is enough for the probes that
    ///      must revert BEFORE the call to the token: `NotOpener` is the very first
    ///      check in `open`, so the signature is never reached. Supplying a real
    ///      signature here would mask any reordering of the guards.
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

    // ── Harness guardrails ────────────────────────────────────────────────
    // The lesson of the audit is that a green invariant proves nothing if the
    // harness cannot reach the state it claims to forbid. The two tests that
    // follow are deterministic — no fuzzing, no luck involved — and check that
    // the campaign can indeed produce the situations that matter.

    /// @notice The handler really does open, honor, slash and refund. If `open`
    ///         reverted systematically — because no agent can sign, say, or because
    ///         the beneficiary drawn is always the agent — the 16,384 calls of a
    ///         campaign would run against an empty set of warrants and ALL the
    ///         invariants would pass without testing a thing.
    function test_Handler_CampaignIsNotVacuous() public {
        for (uint256 i; i < 12; ++i) {
            handler.open(i, i, 1_000e6 * (i + 1), 1 hours, i + 1);
        }
        assertGt(handler.callsOpen(), 0, "the handler opens no warrant at all");
        assertEq(handler.idsLength(), handler.callsOpen(), "ids and counter agree");

        handler.honor(0);
        handler.slash(1);
        handler.warp(2 hours); // beyond the 1 h duration: the warrants expire
        handler.reclaim(2, 0xC0FFEE);

        emit log_named_uint("warrants opened", handler.callsOpen());
        emit log_named_uint("honored", handler.callsHonor());
        emit log_named_uint("slashed", handler.callsSlash());
        emit log_named_uint("reclaimed after expiry", handler.callsReclaim());

        assertGt(handler.callsHonor(), 0, "no honor was ever reached");
        assertGt(handler.callsSlash(), 0, "no slash was ever reached");
        assertGt(handler.callsReclaim(), 0, "no reclaim was ever reached");

        // And the harness really does attempt the diversion of the terms, without
        // ever succeeding. The two assertions go together: the first proves the
        // attack path is taken, the second that it is closed. Without the first,
        // `invariant_I4_FundingRefBindsTheTerms` would be certifying the harness.
        emit log_named_uint("diversions attempted", handler.callsSubstitutionAttempted());
        emit log_named_uint("diversions accepted", handler.callsSubstitutionAccepted());
        assertGt(handler.callsSubstitutionAttempted(), 0, "no diversion was ever attempted");
        assertEq(handler.callsSubstitutionAccepted(), 0, "a diversion got through");
    }

    /// @notice `rotateRoles` really does ATTEMPT to merge the two roles, and it is
    ///         the contract that refuses. This is the sine qua non for
    ///         `invariant_I10` to be an assertion and not a tautology: with the two
    ///         disjoint pools of the pre-audit version, that attempt could not even
    ///         be expressed, and `assertTrue(opener != settler)` passed 16,384 times
    ///         while certifying a property of the harness.
    function test_Handler_RotateRolesAttemptsTheMergeAndIsRefused() public {
        address candidate = handler.openerPool(0);
        assertEq(candidate, handler.settlerPool(0), "shared pool: same address on both sides");

        address settlerBefore = escrow.settler();
        // Identical seeds: `setOpener(role.0)` then `setSettler(role.0)`.
        handler.rotateRoles(0, 0);

        assertEq(escrow.opener(), candidate, "the first rotation did take place");
        assertEq(escrow.settler(), settlerBefore, "the second was refused by RolesMustDiffer");
        assertTrue(escrow.opener() != escrow.settler(), "I10 holds despite the attempted merge");
    }

    // ── I1 ────────────────────────────────────────────────────────────────

    /// @notice I1 — `token.balanceOf(this) >= totalLocked` at every instant.
    function invariant_I1_NeverPromisesMoreThanItHolds() public view {
        assertGe(usdc.balanceOf(address(escrow)), escrow.totalLocked(), "I1 violated: contract is insolvent");
    }

    /// @notice I1 (cross-check) — `totalLocked` is exactly the sum of the `Open` bonds.
    function invariant_I1_TotalLockedMatchesOpenBonds() public view {
        uint256 sum;
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            if (w.status == WarrantEscrow.Status.Open) sum += w.bond;
        }
        assertEq(escrow.totalLocked(), sum, "totalLocked derives from the sum of open bonds");
        assertEq(handler.ghostSumOpenBonds(), sum, "ghost accounting agrees");
    }

    // ── I2 / I3 ───────────────────────────────────────────────────────────

    /// @notice I2 — a warrant leaves `Open` exactly once.
    function invariant_I2_LeavesOpenAtMostOnce() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            assertLe(handler.ghostExits(id), 1, "I2 violated: double exit from Open");
        }
    }

    /// @notice I3 — from `Open`, only `Honored`, `Slashed` and `Reclaimed` are reachable,
    ///         and a final status never changes again.
    function invariant_I3_ClosedStateMachine() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            uint8 status = uint8(w.status);

            // A recorded warrant has never gone back to `None`.
            assertTrue(status != uint8(WarrantEscrow.Status.None), "I3 violated: back to None");

            uint8 recorded = handler.ghostFinalStatus(id);
            if (recorded == 0) {
                assertEq(status, uint8(WarrantEscrow.Status.Open), "I3 violated: untracked exit");
            } else {
                assertEq(status, recorded, "I3 violated: final status mutated");
                assertTrue(
                    status == uint8(WarrantEscrow.Status.Honored)
                        || status == uint8(WarrantEscrow.Status.Slashed)
                        || status == uint8(WarrantEscrow.Status.Reclaimed),
                    "I3 violated: state outside the machine"
                );
            }
        }
    }

    // ── I4 ────────────────────────────────────────────────────────────────

    /// @notice I4 — `conditionHash` and `actionHash` are immutable after `open`.
    function invariant_I4_CommitmentIsImmutable() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            assertEq(w.conditionHash, handler.ghostConditionHash(id), "I4 violated: conditionHash rewritten");
            assertEq(w.actionHash, handler.ghostActionHash(id), "I4 violated: actionHash rewritten");
            assertEq(w.bond, handler.ghostBond(id), "I4 violated: bond rewritten");
            assertEq(w.agent, handler.ghostAgent(id), "I4 violated: agent rewritten");
        }
    }

    /// @notice I4 (the half added by the audit) — `agent` is whoever SIGNED, and
    ///         `fundingRef` is the nonce of its authorization. The link between the
    ///         payer and the recipient of the refund is no longer declarative: the
    ///         token marked that nonce as spent by that address, and by no other.
    ///         This is the property that closes vulnerability 02.
    function invariant_I4_AgentIsTheProvenPayer() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            WarrantEscrow.Warrant memory w = escrow.getWarrant(handler.ids(i));
            assertTrue(
                usdc.authorizationState(w.agent, w.fundingRef),
                "I4 violated: warrant with no authorization spent by its agent"
            );
        }
    }

    /// @notice I4 (final half) — **the binding of the terms, in its permanent
    ///         form**. Every warrant, at every instant of the campaign, satisfies
    ///         `fundingRef == termsHash(its own terms)`. The agent's signature
    ///         covers the nonce; the nonce is that hash; therefore the agent signed
    ///         those exact terms — beneficiary, post-condition, action and duration
    ///         included — and not a bare payment order that the `opener` could then
    ///         back with whatever it fancied.
    /// @dev    Entirely reconstructed from onchain state, with no ghost variable:
    ///         `duration` reads back as `expiry - openedAt`. That is deliberate — a
    ///         check that needs nothing but the contract is also one a third party
    ///         can redo for themselves on the chain.
    function invariant_I4_FundingRefBindsTheTerms() public view {
        // The harness ATTEMPTS the diversion on one opening in seven; not one may
        // have succeeded. This line is what stops the invariant from being a
        // tautology about the harness rather than a property of the contract.
        assertEq(handler.callsSubstitutionAccepted(), 0, "diversion of the terms was accepted");

        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            assertEq(
                w.fundingRef,
                escrow.termsHash(
                    id, w.beneficiary, w.bond, w.conditionHash, w.actionHash, uint64(w.expiry - w.openedAt)
                ),
                "I4 violated: fundingRef does not hash the warrant terms"
            );
        }
    }

    // ── I5 ────────────────────────────────────────────────────────────────

    /// @notice I5 — after `expiry`, `reclaim` **always** succeeds for an `Open` warrant,
    ///         whoever the caller is, and refunds the whole bond to the agent.
    function invariant_I5_ReclaimAlwaysSucceedsAfterExpiry() public {
        uint256 snap = vm.snapshotState();
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            WarrantEscrow.Warrant memory w = escrow.getWarrant(id);
            if (w.status != WarrantEscrow.Status.Open || block.timestamp <= w.expiry) continue;

            uint256 before = usdc.balanceOf(w.agent);
            vm.prank(address(0xBEEF)); // some third party, with no privilege whatsoever
            escrow.reclaim(id);
            assertEq(usdc.balanceOf(w.agent) - before, w.bond, "I5 violated: partial refund");
        }
        vm.revertToState(snap);
    }

    // ── I6 ────────────────────────────────────────────────────────────────

    /// @notice I6 — `slash` takes no fee. The treasury has never moved by a single
    ///         unit on a slash (nor on a `reclaim`).
    function invariant_I6_SlashTakesNoFee() public view {
        assertEq(handler.ghostFeesFromSlash(), 0, "I6 violated: fee taken on a slash");
        assertEq(usdc.balanceOf(treasury), handler.ghostFeesFromHonor(), "treasury fed by honor alone");
    }

    /// @notice I6 (the half added by the audit) — no warrant can name the treasury
    ///         as beneficiary, nor the agent itself, nor the contract. I6 stops
    ///         being a property of the settlement paths alone and becomes a property
    ///         of the state: the case has become unreachable.
    function invariant_I6_NoDegenerateBeneficiary() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            WarrantEscrow.Warrant memory w = escrow.getWarrant(handler.ids(i));
            assertTrue(w.beneficiary != treasury, "I6 violated: beneficiary = treasury");
            assertTrue(w.beneficiary != w.agent, "beneficiary = agent");
            assertTrue(w.beneficiary != address(escrow), "beneficiary = escrow");
        }
    }

    // ── I7 ────────────────────────────────────────────────────────────────

    /// @notice I7 — `feeBps <= MAX_FEE_BPS` at all times, and the rate frozen inside
    ///         each warrant honours the cap too (it is a snapshot of it).
    function invariant_I7_FeeCapHolds() public view {
        assertLe(escrow.feeBps(), escrow.MAX_FEE_BPS(), "I7 violated: fee cap exceeded");
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            assertLe(
                escrow.getWarrant(handler.ids(i)).feeBpsAtOpen,
                escrow.MAX_FEE_BPS(),
                "I7 violated: frozen rate above the cap"
            );
        }
    }

    // ── I8 ────────────────────────────────────────────────────────────────

    /// @notice I8 — exact conservation: every address holds precisely what the
    ///         sequence of settlements paid it (`bond - bond·feeBpsAtOpen/10000` on
    ///         `honor`), less the bonds it paid in itself.
    function invariant_I8_Conservation() public view {
        uint256 distributed;
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actorAt(i);
            assertEq(
                usdc.balanceOf(actor), handler.ghostExpectedBalance(actor), "I8 violated: unexpected amount"
            );
            distributed += usdc.balanceOf(actor);
        }
        distributed += usdc.balanceOf(treasury);
        assertEq(
            usdc.totalSupply(),
            distributed + usdc.balanceOf(address(escrow)),
            "global conservation of the asset"
        );
    }

    // ── I9 ────────────────────────────────────────────────────────────────

    /// @notice I9 — past `expiry`, `honor` and `slash` revert. This is what makes I5 true
    ///         against a **hostile** settler and not merely against a passive one.
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
            assertFalse(okHonor, "I9 violated: honor after expiry");
            _assertRevertsWith(errHonor, WarrantEscrow.Expired.selector, "I9: wrong error on honor");

            vm.prank(settler);
            (bool okSlash, bytes memory errSlash) =
                address(escrow).call(abi.encodeCall(WarrantEscrow.slash, (id, bytes32(0), string("hostile"))));
            assertFalse(okSlash, "I9 violated: slash after expiry");
            _assertRevertsWith(errSlash, WarrantEscrow.Expired.selector, "I9: wrong error on slash");

            // ...and the permissionless refund goes through in the same block (front-run).
            vm.prank(address(0xBEEF));
            escrow.reclaim(id);
        }
        vm.revertToState(snap);
    }

    // ── I10 ───────────────────────────────────────────────────────────────

    /// @notice I10 — roles that are distinct and strictly partitioned: the settler cannot
    ///         open, the opener cannot settle, and the owner can do neither.
    /// @dev    `assertTrue(opener != settler)` is a *real* assertion only because
    ///         `rotateRoles` draws from a shared pool and therefore attempts the
    ///         merge at every step. Removing `RolesMustDiffer` from
    ///         `setOpener`/`setSettler` must make this invariant fail: that is how
    ///         we check it tests the contract, and not the harness.
    function invariant_I10_RolesAreDistinctAndEnforced() public {
        address opener = escrow.opener();
        address settler = escrow.settler();
        assertTrue(opener != settler, "I10 violated: opener == settler");

        uint256 snap = vm.snapshotState();

        // The settler cannot open.
        vm.prank(settler);
        (bool ok, bytes memory err) = address(escrow)
            .call(
                abi.encodeCall(
                    WarrantEscrow.open,
                    (keccak256("probe"), address(2), 1, bytes32(0), bytes32(0), 1 hours, _dummyAuth())
                )
            );
        assertFalse(ok, "I10 violated: the settler managed to open");
        _assertRevertsWith(err, WarrantEscrow.NotOpener.selector, "I10: wrong error on open");

        // The opener can neither honor nor slash.
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            if (escrow.getWarrant(id).status != WarrantEscrow.Status.Open) continue;

            vm.prank(opener);
            (ok, err) = address(escrow).call(abi.encodeCall(WarrantEscrow.honor, (id, bytes32(0))));
            assertFalse(ok, "I10 violated: the opener managed to honor");
            _assertRevertsWith(err, WarrantEscrow.NotSettler.selector, "I10: wrong error on honor");

            vm.prank(opener);
            (ok, err) =
                address(escrow).call(abi.encodeCall(WarrantEscrow.slash, (id, bytes32(0), string("x"))));
            assertFalse(ok, "I10 violated: the opener managed to slash");
            _assertRevertsWith(err, WarrantEscrow.NotSettler.selector, "I10: wrong error on slash");
            break; // one open warrant is enough to prove the partition at this step
        }

        vm.revertToState(snap);
    }
}
