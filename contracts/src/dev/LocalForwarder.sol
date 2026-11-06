// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReportReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice Local-chain stand-in for the Chainlink forwarder, so the vault code path is identical
///         on anvil. On Arc Testnet the vault points at the CRE MockKeystoneForwarder (simulation)
///         or the KeystoneForwarder (deployed workflow) instead.
contract LocalForwarder {
    address public owner;

    event Forwarded(address indexed receiver, bytes report);

    constructor() {
        owner = msg.sender;
    }

    function forward(address receiver, bytes calldata report) external {
        require(msg.sender == owner, "not owner");
        // Same 64-byte metadata width the KeystoneForwarder passes (all zero: no workflow identity).
        IReportReceiver(receiver).onReport(new bytes(64), report);
        emit Forwarded(receiver, report);
    }
}
