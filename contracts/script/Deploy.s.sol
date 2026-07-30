// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {WarrantEscrow} from "../src/WarrantEscrow.sol";

/// @title Deploy — deployment of `WarrantEscrow`
/// @notice Usage:
///   forge script script/Deploy.s.sol --rpc-url $BASE_RPC --broadcast --verify \
///     --sig "run(address,address,address,address,uint16)" \
///     0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 $TREASURY $OPENER $SETTLER 250
/// @dev `opener` and `settler` MUST be two distinct keys, on two distinct machines:
///      merging them voids invariant I10 and falsifies the whole security table of
///      `06-contrat-escrow.md` § 4. The script therefore refuses to deploy.
///
///      Since the audit, `WarrantEscrow` enforces that constraint itself in its
///      constructor (`RolesMustDiffer`). The check below is therefore redundant, and
///      that is exactly why it is kept: defence in depth, and above all an explicit
///      error message at the moment the operator can still fix their configuration.
///      The contract is what guarantees the property; the script is only a
///      convenience — a deployer who skips it runs into the constructor instead.
contract Deploy is Script {
    /// @notice The opener and the settler cannot be the same address (I10).
    error RolesMustBeDistinct();
    error ZeroAddress();
    error FeeTooHigh();

    function run(address token, address treasury, address opener, address settler, uint16 feeBps)
        external
        returns (WarrantEscrow escrow)
    {
        // I10 — a deployment guardrail. Bypassable as such: nothing forces anyone
        // to go through this script. It now doubles the constructor's own guard,
        // which is where the real guarantee lives.
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
