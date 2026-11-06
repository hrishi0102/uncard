// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AnyCheckoutVault} from "../src/AnyCheckoutVault.sol";
import {MockUSDC} from "../src/dev/MockUSDC.sol";
import {LocalForwarder} from "../src/dev/LocalForwarder.sol";
import {MockMessageTransmitterV2} from "../src/dev/MockMessageTransmitterV2.sol";

contract AnyCheckoutVaultTest is Test {
    MockUSDC usdc;
    LocalForwarder fwd;
    MockMessageTransmitterV2 mt;
    AnyCheckoutVault vault;

    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant USD = 1e6;
    uint64 constant TTL = 15 minutes;
    uint64 constant GRACE = 30 minutes;
    bytes32 constant MERCHANT = keccak256("chai-co.example");

    function setUp() public {
        vm.warp(1_762_000_000);
        usdc = new MockUSDC();
        fwd = new LocalForwarder();
        mt = new MockMessageTransmitterV2(address(usdc));
        vault = new AnyCheckoutVault(address(usdc), operator, address(fwd), treasury, address(mt), GRACE);

        usdc.mint(alice, 1_000 * USD);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(500 * USD);
        vault.setPolicy(uint128(200 * USD), uint128(100 * USD), true);
        vm.stopPrank();
    }

    // ---------------- helpers ----------------

    function _req(bytes32 id, address user, uint256 amount, bytes32 approvalRef)
        internal
        pure
        returns (AnyCheckoutVault.HoldRequest memory)
    {
        return AnyCheckoutVault.HoldRequest(id, user, amount, TTL, MERCHANT, keccak256(abi.encode("card", id)), approvalRef);
    }

    function _open(string memory intent, uint256 amount, bytes32 approvalRef) internal returns (bytes32 id) {
        id = keccak256(bytes(intent));
        vm.prank(operator);
        vault.openHold(_req(id, alice, amount, approvalRef));
    }

    function _report(uint8 action, bytes32 id, uint256 charged, bytes32 ref) internal {
        fwd.forward(address(vault), abi.encode(address(vault), action, id, charged, ref));
    }

    function _acct(address u) internal view returns (AnyCheckoutVault.Account memory a, uint256 remaining) {
        (a, remaining,) = vault.getAccount(u);
    }

    // ---------------- deposits ----------------

    function test_depositAndWithdraw() public {
        (AnyCheckoutVault.Account memory a,) = _acct(alice);
        assertEq(a.available, 500 * USD);
        vm.prank(alice);
        vault.withdraw(100 * USD);
        (a,) = _acct(alice);
        assertEq(a.available, 400 * USD);
        assertEq(usdc.balanceOf(alice), 600 * USD);
        assertEq(vault.totalAccounted(), 400 * USD);
    }

    function test_depositFor() public {
        usdc.mint(bob, 50 * USD);
        vm.startPrank(bob);
        usdc.approve(address(vault), 50 * USD);
        vault.depositFor(alice, 50 * USD);
        vm.stopPrank();
        (AnyCheckoutVault.Account memory a,) = _acct(alice);
        assertEq(a.available, 550 * USD);
    }

    // ---------------- holds inside policy ----------------

    function test_openHoldWithinPolicyNeedsNoUserSignature() public {
        bytes32 id = _open("intent-1", 42 * USD, bytes32(0));
        (AnyCheckoutVault.Account memory a, uint256 remaining) = _acct(alice);
        assertEq(a.available, 458 * USD);
        assertEq(a.locked, 42 * USD);
        assertEq(remaining, 158 * USD);
        AnyCheckoutVault.Hold memory h = vault.getHold(id);
        assertEq(uint8(h.status), uint8(AnyCheckoutVault.HoldStatus.Open));
        assertEq(h.expiresAt, block.timestamp + TTL);
        assertFalse(h.humanApproved);
        assertEq(h.cardRef, keccak256(abi.encode("card", id)));
    }

    function test_onlyOperatorCanOpen() public {
        vm.prank(alice);
        vm.expectRevert(AnyCheckoutVault.NotOperator.selector);
        vault.openHold(_req(keccak256("x"), alice, 1 * USD, bytes32(0)));
    }

    function test_overPerPurchaseLimitNeedsHuman() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(AnyCheckoutVault.OverPerPurchaseLimit.selector, 150 * USD, 100 * USD));
        vault.openHold(_req(keccak256("big"), alice, 150 * USD, bytes32(0)));

        // Same purchase after a World ID approval goes through and does not use the allowance.
        bytes32 id = _open("big", 150 * USD, keccak256("world-approval"));
        assertTrue(vault.getHold(id).humanApproved);
        (, uint256 remaining) = _acct(alice);
        assertEq(remaining, 200 * USD);
    }

    function test_weeklyLimitAndWindowReset() public {
        _open("a", 90 * USD, bytes32(0));
        _open("b", 90 * USD, bytes32(0));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(AnyCheckoutVault.OverWeeklyLimit.selector, 30 * USD, 20 * USD));
        vault.openHold(_req(keccak256("c"), alice, 30 * USD, bytes32(0)));

        vm.warp(block.timestamp + 7 days);
        _open("c", 30 * USD, bytes32(0));
        (, uint256 remaining) = _acct(alice);
        assertEq(remaining, 170 * USD);
    }

    function test_killSwitch() public {
        vm.prank(alice);
        vault.setPolicy(uint128(200 * USD), uint128(100 * USD), false);
        vm.prank(operator);
        vm.expectRevert(AnyCheckoutVault.AgentDisabled.selector);
        vault.openHold(_req(keccak256("x"), alice, 1 * USD, keccak256("approval")));
    }

    function test_insufficientBalance() public {
        vm.prank(alice);
        vault.setPolicy(uint128(10_000 * USD), uint128(10_000 * USD), true);
        vm.prank(operator);
        vm.expectRevert(AnyCheckoutVault.InsufficientBalance.selector);
        vault.openHold(_req(keccak256("x"), alice, 501 * USD, bytes32(0)));
    }

    function test_holdIdCannotBeReused() public {
        _open("dup", 10 * USD, bytes32(0));
        vm.prank(operator);
        vm.expectRevert(AnyCheckoutVault.HoldExists.selector);
        vault.openHold(_req(keccak256(bytes("dup")), alice, 10 * USD, bytes32(0)));
    }

    // ---------------- settlement ----------------

    function test_settlePaysOnlyWhatWasCharged() public {
        bytes32 id = _open("partial", 54_99 * 1e4, bytes32(0)); // $54.99 locked
        _report(1, id, 50 * USD, keccak256("txn_1")); // merchant charged $50.00

        assertEq(usdc.balanceOf(treasury), 50 * USD);
        (AnyCheckoutVault.Account memory a, uint256 remaining) = _acct(alice);
        assertEq(a.locked, 0);
        assertEq(a.available, 450 * USD); // 500 - 50
        assertEq(remaining, 150 * USD); // unspent $4.99 went back to the allowance
        AnyCheckoutVault.Hold memory h = vault.getHold(id);
        assertEq(uint8(h.status), uint8(AnyCheckoutVault.HoldStatus.Settled));
        assertEq(h.charged, 50 * USD);
        assertEq(vault.totalAccounted(), 450 * USD);
        assertEq(usdc.balanceOf(address(vault)), 450 * USD);
    }

    function test_refundOnDecline() public {
        bytes32 id = _open("declined", 80 * USD, bytes32(0));
        _report(2, id, 0, keccak256("card_not_supported"));
        (AnyCheckoutVault.Account memory a, uint256 remaining) = _acct(alice);
        assertEq(a.available, 500 * USD);
        assertEq(a.locked, 0);
        assertEq(remaining, 200 * USD);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_onlyForwarderCanReport() public {
        bytes32 id = _open("x", 10 * USD, bytes32(0));
        vm.prank(operator);
        vm.expectRevert(AnyCheckoutVault.NotForwarder.selector);
        vault.onReport(new bytes(64), abi.encode(address(vault), uint8(1), id, 10 * USD, bytes32(0)));
    }

    function test_reportForOtherVaultRejected() public {
        bytes32 id = _open("x", 10 * USD, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AnyCheckoutVault.WrongVault.selector, address(0xBEEF)));
        fwd.forward(address(vault), abi.encode(address(0xBEEF), uint8(1), id, 10 * USD, bytes32(0)));
    }

    function test_chargeAboveHoldRejected() public {
        bytes32 id = _open("x", 10 * USD, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AnyCheckoutVault.ChargeExceedsHold.selector, 11 * USD, 10 * USD));
        _report(1, id, 11 * USD, bytes32(0));
    }

    function test_noDoubleSettlement() public {
        bytes32 id = _open("x", 10 * USD, bytes32(0));
        _report(1, id, 10 * USD, bytes32(0));
        vm.expectRevert(AnyCheckoutVault.HoldNotOpen.selector);
        _report(1, id, 10 * USD, bytes32(0));
        vm.expectRevert(AnyCheckoutVault.HoldNotOpen.selector);
        _report(2, id, 0, bytes32(0));
    }

    function test_workflowIdentityCheck() public {
        bytes32 wid = keccak256("workflow");
        address wowner = makeAddr("workflowOwner");
        vault.setExpectedWorkflow(wid, wowner);
        bytes32 id = _open("x", 10 * USD, bytes32(0));

        // LocalForwarder sends zeroed metadata, so it must now fail.
        vm.expectRevert(AnyCheckoutVault.WrongWorkflow.selector);
        _report(1, id, 10 * USD, bytes32(0));

        // Correct metadata from the forwarder passes.
        bytes memory meta = abi.encodePacked(wid, bytes10("anychk_set"), wowner, bytes2(0));
        vm.prank(address(fwd));
        vault.onReport(meta, abi.encode(address(vault), uint8(1), id, 10 * USD, bytes32(0)));
        assertEq(uint8(vault.getHold(id).status), uint8(AnyCheckoutVault.HoldStatus.Settled));
    }

    // ---------------- timeouts and cancels ----------------

    function test_expireAfterTtlPlusGrace() public {
        bytes32 id = _open("slow", 25 * USD, bytes32(0));
        vm.warp(block.timestamp + TTL);
        vm.expectRevert(
            abi.encodeWithSelector(AnyCheckoutVault.NotExpired.selector, vault.getHold(id).expiresAt + GRACE)
        );
        vault.expireHold(id);

        vm.warp(block.timestamp + GRACE);
        vm.prank(bob); // anyone can trigger the refund
        vault.expireHold(id);
        (AnyCheckoutVault.Account memory a,) = _acct(alice);
        assertEq(a.available, 500 * USD);
        assertEq(vault.getHold(id).chargeRef, vault.REASON_TIMEOUT());
    }

    function test_operatorCancelOnlyRefunds() public {
        bytes32 id = _open("x", 25 * USD, bytes32(0));
        vm.prank(operator);
        vault.cancelHold(id);
        (AnyCheckoutVault.Account memory a,) = _acct(alice);
        assertEq(a.available, 500 * USD);
    }

    // ---------------- CCTP V2 bridged deposits ----------------

    function test_claimBridgedDepositCreditsSender() public {
        bytes memory message = mt.buildMessage(
            6, 26, keccak256("n1"), address(vault), address(vault), address(0xB5), bob, 75 * USD, 1e4, ""
        );
        vault.claimBridgedDeposit(message, "");
        (AnyCheckoutVault.Account memory a,) = _acct(bob);
        assertEq(a.available, 75 * USD - 1e4); // minus the CCTP fast-transfer fee
        assertEq(vault.totalAccounted(), 500 * USD + 75 * USD - 1e4);

        vm.expectRevert(bytes("nonce used"));
        vault.claimBridgedDeposit(message, "");
    }

    function test_claimBridgedDepositHookBeneficiary() public {
        bytes memory message = mt.buildMessage(
            6, 26, keccak256("n2"), address(vault), address(vault), address(0xB5), bob, 10 * USD, 0, abi.encode(alice)
        );
        vault.claimBridgedDeposit(message, "");
        (AnyCheckoutVault.Account memory a,) = _acct(alice);
        assertEq(a.available, 510 * USD);
    }

    function test_claimRejectsMessageNotBoundToVault() public {
        bytes memory message = mt.buildMessage(
            6, 26, keccak256("n3"), address(vault), address(0), address(0xB5), bob, 10 * USD, 0, ""
        );
        vm.expectRevert(AnyCheckoutVault.BadBridgeMessage.selector);
        vault.claimBridgedDeposit(message, "");
    }

    function test_sweepOnlySurplus() public {
        usdc.mint(address(vault), 7 * USD); // stray funds
        uint256 swept = vault.sweepSurplus(bob);
        assertEq(swept, 7 * USD);
        assertEq(usdc.balanceOf(address(vault)), 500 * USD);
    }

    function test_supportsReceiverInterface() public view {
        assertTrue(vault.supportsInterface(0x805f2132)); // IReceiver.onReport selector-derived id
        assertTrue(vault.supportsInterface(0x01ffc9a7)); // IERC165
    }
}
