// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AnyCheckoutVault} from "../src/AnyCheckoutVault.sol";
import {MockUSDC} from "../src/dev/MockUSDC.sol";
import {LocalForwarder} from "../src/dev/LocalForwarder.sol";
import {MockMessageTransmitterV2} from "../src/dev/MockMessageTransmitterV2.sol";

/// Deploys AnyCheckoutVault.
///
/// Local anvil (deploys mock USDC, a LocalForwarder and a mock CCTP transmitter):
///   forge script script/Deploy.s.sol --rpc-url local --broadcast --private-key $DEPLOYER_PK
///
/// Arc Testnet (real USDC, CRE MockKeystoneForwarder for `cre workflow simulate --broadcast`):
///   USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
///   FORWARDER_ADDRESS=0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1 \
///   MESSAGE_TRANSMITTER=<Arc testnet MessageTransmitterV2> \
///   OPERATOR_ADDRESS=0x... TREASURY_ADDRESS=0x... \
///   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key $DEPLOYER_PK
contract Deploy is Script {
    function run() external {
        address deployer = msg.sender;
        address usdc = vm.envOr("USDC_ADDRESS", address(0));
        address forwarder = vm.envOr("FORWARDER_ADDRESS", address(0));
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address transmitter = vm.envOr("MESSAGE_TRANSMITTER", address(0));
        uint64 grace = uint64(vm.envOr("SETTLEMENT_GRACE", uint256(30 minutes)));

        vm.startBroadcast();
        bool mockUsdc = usdc == address(0);
        if (mockUsdc) usdc = address(new MockUSDC());
        bool localForwarder = forwarder == address(0);
        if (localForwarder) forwarder = address(new LocalForwarder());
        if (transmitter == address(0) && mockUsdc) transmitter = address(new MockMessageTransmitterV2(usdc));

        AnyCheckoutVault vault = new AnyCheckoutVault(usdc, operator, forwarder, treasury, transmitter, grace);
        vm.stopBroadcast();

        console2.log("AnyCheckoutVault", address(vault));
        console2.log("USDC", usdc);
        console2.log("Forwarder", forwarder);
        console2.log("MessageTransmitter", transmitter);

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "vault", address(vault));
        vm.serializeAddress(key, "usdc", usdc);
        vm.serializeBool(key, "mockUsdc", mockUsdc);
        vm.serializeAddress(key, "forwarder", forwarder);
        vm.serializeBool(key, "localForwarder", localForwarder);
        vm.serializeAddress(key, "messageTransmitter", transmitter);
        vm.serializeAddress(key, "operator", operator);
        vm.serializeAddress(key, "treasury", treasury);
        string memory json = vm.serializeUint(key, "deployBlock", block.number);
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
