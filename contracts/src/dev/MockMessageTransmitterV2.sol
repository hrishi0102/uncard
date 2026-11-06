// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Test double for Circle CCTP V2 MessageTransmitterV2.receiveMessage.
///         Parses the real MessageV2 + BurnMessageV2 layout and mints (amount - feeExecuted).
contract MockMessageTransmitterV2 {
    IMintable public immutable token;
    mapping(bytes32 => bool) public usedNonces;

    constructor(address token_) {
        token = IMintable(token_);
    }

    function receiveMessage(bytes calldata message, bytes calldata) external returns (bool) {
        bytes32 nonce = bytes32(message[12:44]);
        require(!usedNonces[nonce], "nonce used");
        usedNonces[nonce] = true;

        bytes32 destinationCaller = bytes32(message[108:140]);
        require(
            destinationCaller == bytes32(0) || destinationCaller == bytes32(uint256(uint160(msg.sender))),
            "invalid caller"
        );

        bytes calldata body = message[148:];
        address mintRecipient = address(uint160(uint256(bytes32(body[36:68]))));
        uint256 amount = uint256(bytes32(body[68:100]));
        uint256 feeExecuted = uint256(bytes32(body[164:196]));
        token.mint(mintRecipient, amount - feeExecuted);
        return true;
    }

    /// @notice Build a CCTP V2 burn message the same way Circle does (for tests and local demos).
    function buildMessage(
        uint32 sourceDomain,
        uint32 destinationDomain,
        bytes32 nonce,
        address mintRecipient,
        address destinationCaller,
        address burnToken,
        address messageSender,
        uint256 amount,
        uint256 feeExecuted,
        bytes calldata hookData
    ) external pure returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            uint32(1),
            bytes32(uint256(uint160(burnToken))),
            bytes32(uint256(uint160(mintRecipient))),
            amount,
            bytes32(uint256(uint160(messageSender))),
            uint256(feeExecuted), // maxFee
            feeExecuted,
            uint256(0), // expirationBlock
            hookData
        );
        return abi.encodePacked(
            uint32(1),
            sourceDomain,
            destinationDomain,
            nonce,
            bytes32(0), // sender (source TokenMessenger)
            bytes32(0), // recipient (destination TokenMessenger)
            bytes32(uint256(uint160(destinationCaller))),
            uint32(1000),
            uint32(1000),
            body
        );
    }
}
