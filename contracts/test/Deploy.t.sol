// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @title Guardrails of the deployment script
/// @dev The "one single key for both opener and settler" shortcut would void I10 and falsify
///      the whole security table of `06-contrat-escrow.md` § 4. The script must refuse.
contract DeployTest is Test {
    Deploy internal deployer;
    address internal token;
    address internal treasury = makeAddr("treasury");
    address internal opener = makeAddr("opener");
    address internal settler = makeAddr("settler");

    function setUp() public {
        deployer = new Deploy();
        token = address(new MockUSDC());
    }

    function test_Deploy_Succeeds() public {
        WarrantEscrow escrow = deployer.run(token, treasury, opener, settler, 250);
        assertEq(address(escrow.token()), token);
        assertEq(escrow.treasury(), treasury);
        assertEq(escrow.opener(), opener);
        assertEq(escrow.settler(), settler);
        assertEq(escrow.feeBps(), 250);
        assertTrue(escrow.opener() != escrow.settler());
    }

    /// @dev I10 — the shortcut taken at 3 a.m., and which must fail loudly.
    function test_Deploy_RevertsWhenOpenerEqualsSettler() public {
        vm.expectRevert(Deploy.RolesMustBeDistinct.selector);
        deployer.run(token, treasury, opener, opener, 250);
    }

    /// @dev The script's guard is now REDUNDANT with the constructor's, and that is
    ///      exactly why it is kept. This test documents both layers: bypassing the
    ///      script — which nothing prevents — does not bypass I10, it only changes
    ///      which error you get. That is the difference between an operational
    ///      convention and a guarantee, and it is what the audit held against the
    ///      previous version, where only the former existed.
    function test_Deploy_ContractEnforcesI10EvenWithoutTheScript() public {
        vm.expectRevert(Deploy.RolesMustBeDistinct.selector);
        deployer.run(token, treasury, opener, opener, 250);

        // Direct deployment, script bypassed: the constructor refuses all the same.
        vm.expectRevert(WarrantEscrow.RolesMustDiffer.selector);
        new WarrantEscrow(token, treasury, opener, opener, 250);
    }

    function test_Deploy_RevertsOnFeeAboveCap() public {
        vm.expectRevert(Deploy.FeeTooHigh.selector);
        deployer.run(token, treasury, opener, settler, 501);
    }

    function test_Deploy_RevertsOnZeroAddress() public {
        vm.expectRevert(Deploy.ZeroAddress.selector);
        deployer.run(address(0), treasury, opener, settler, 250);

        vm.expectRevert(Deploy.ZeroAddress.selector);
        deployer.run(token, address(0), opener, settler, 250);

        vm.expectRevert(Deploy.ZeroAddress.selector);
        deployer.run(token, treasury, address(0), settler, 250);

        vm.expectRevert(Deploy.ZeroAddress.selector);
        deployer.run(token, treasury, opener, address(0), 250);
    }
}
