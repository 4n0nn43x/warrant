// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";

/// @title Deploy — déploiement de `WarrantEscrow`
/// @notice Usage :
///   forge script script/Deploy.s.sol --rpc-url $BASE_RPC --broadcast --verify \
///     --sig "run(address,address,address,address,uint16)" \
///     0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 $TREASURY $OPENER $SETTLER 250
/// @dev `opener` et `settler` DOIVENT être deux clés distinctes, sur deux machines
///      distinctes : les réunir annule l'invariant I10 et rend faux tout le tableau de
///      sécurité de `06-contrat-escrow.md` § 4. Le script refuse donc de déployer.
contract Deploy is Script {
    /// @notice L'opener et le settler ne peuvent pas être la même adresse (I10).
    error RolesMustBeDistinct();
    error ZeroAddress();
    error FeeTooHigh();

    function run(address token, address treasury, address opener, address settler, uint16 feeBps)
        external
        returns (WarrantEscrow escrow)
    {
        // I10 — garde-fou de déploiement, non contournable.
        if (opener == settler) revert RolesMustBeDistinct();
        if (token == address(0) || treasury == address(0)) revert ZeroAddress();
        if (opener == address(0) || settler == address(0)) revert ZeroAddress();
        if (feeBps > 500) revert FeeTooHigh(); // = WarrantEscrow.MAX_FEE_BPS

        vm.startBroadcast();
        escrow = new WarrantEscrow(token, treasury, opener, settler, feeBps);
        vm.stopBroadcast();

        console2.log("WarrantEscrow  :", address(escrow));
        console2.log("token          :", token);
        console2.log("treasury       :", treasury);
        console2.log("opener         :", opener);
        console2.log("settler        :", settler);
        console2.log("feeBps         :", feeBps);
    }
}
