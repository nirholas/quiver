// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {QuiverSettlement} from "../src/QuiverSettlement.sol";

/// Deterministic CREATE2 deploy through Arachnid's deployer: same address on 4663 and 46630.
contract DeploySettlement is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 constant SALT = keccak256("quiver.settlement.v1");

    function run() external returns (address expected) {
        uint256 feeBps = vm.envOr("SETTLEMENT_FEE_BPS", uint256(0));
        address feeRecipient = vm.envOr("SETTLEMENT_FEE_RECIPIENT", address(0));
        bytes memory initCode = abi.encodePacked(type(QuiverSettlement).creationCode, abi.encode(PERMIT2, feeBps, feeRecipient));
        expected = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_DEPLOYER);
        console2.log("chainId", block.chainid);
        console2.log("expected QuiverSettlement", expected);
        require(PERMIT2.code.length > 0 && CREATE2_DEPLOYER.code.length > 0, "prerequisites missing");
        if (expected.code.length > 0) {
            console2.log("already deployed");
            return expected;
        }
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
        vm.stopBroadcast();
        require(ok && expected.code.length > 0, "CREATE2 deploy failed");
        console2.log("deployed QuiverSettlement", expected);
    }
}
