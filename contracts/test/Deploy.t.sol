// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @title Garde-fous du script de déploiement
/// @dev Le raccourci « une seule clé pour l'opener et le settler » annulerait I10 et rendrait
///      faux tout le tableau de sécurité de `06-contrat-escrow.md` § 4. Le script doit refuser.
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

    /// @dev I10 — le cas qu'on prend à 3 h du matin, et qui doit échouer bruyamment.
    function test_Deploy_RevertsWhenOpenerEqualsSettler() public {
        vm.expectRevert(Deploy.RolesMustBeDistinct.selector);
        deployer.run(token, treasury, opener, opener, 250);
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
