// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
    AnyCheckoutVault
    ----------------
    Conditional USDC escrow for AI-agent card purchases, built for Arc.

    1. A user deposits USDC once (directly, or bridged in with CCTP V2 after a Uniswap swap).
    2. The user sets an agent policy: a weekly allowance and a per-purchase limit.
       This is the only wallet pop-up. After that, the agent never needs a signature.
    3. For each checkout, the AnyCheckout operator opens a hold for the exact cart total.
       Inside the policy it needs no human. Above it, it needs a World ID approval
       (approvalRef), which the backend only gets after a fresh human verification.
    4. A single-use virtual card is issued for that amount and the agent pays with it.
    5. A Chainlink CRE workflow reads the real card result from the card issuer API and
       writes a signed report through the Chainlink forwarder:
         SETTLE -> exactly the charged amount goes to the treasury (which funded the card),
                   the rest goes straight back to the user.
         REFUND -> declined or voided: the full hold goes back to the user.
    6. If nothing is reported, anyone can expire the hold after ttl + grace: full refund.

    Single file on purpose (no imports) so it can be pasted into Arc Studio as is.
    Only the USDC ERC-20 interface (6 decimals) is used, never msg.value (Arc native USDC is 18 decimals).
*/

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC165Like {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE consumer interface. The KeystoneForwarder calls onReport.
interface IReceiver is IERC165Like {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice Subset of Circle CCTP V2 MessageTransmitterV2.
interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}

contract AnyCheckoutVault is IReceiver {
    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint8 public constant ACTION_SETTLE = 1;
    uint8 public constant ACTION_REFUND = 2;

    uint64 public constant WINDOW = 7 days;
    uint64 public constant MIN_TTL = 60;
    uint64 public constant MAX_TTL = 1 days;

    bytes32 public constant REASON_TIMEOUT = keccak256("TIMEOUT");
    bytes32 public constant REASON_CANCELED = keccak256("CANCELED");

    // CCTP V2 message layout (MessageV2 header, then BurnMessageV2 body)
    uint256 private constant MSG_SOURCE_DOMAIN = 4;
    uint256 private constant MSG_NONCE = 12;
    uint256 private constant MSG_DESTINATION_CALLER = 108;
    uint256 private constant MSG_BODY = 148;
    uint256 private constant BODY_MINT_RECIPIENT = 36;
    uint256 private constant BODY_MESSAGE_SENDER = 100;
    uint256 private constant BODY_HOOK_DATA = 228;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct Account {
        uint256 available; // free balance the user can withdraw or the agent can use
        uint256 locked; // sum of open holds
        uint128 weeklyLimit; // what the agent may spend per 7-day window without a human
        uint128 perPurchaseLimit; // max single purchase without a human
        uint128 spentInWindow; // autonomous spend in the current window
        uint64 windowStart;
        bool agentEnabled;
    }

    enum HoldStatus {
        None,
        Open,
        Settled,
        Refunded
    }

    struct Hold {
        address user;
        HoldStatus status;
        bool humanApproved;
        uint64 openedAt;
        uint64 expiresAt;
        uint256 amount; // locked amount (USDC, 6 decimals)
        uint256 charged; // what the merchant actually charged
        bytes32 merchantRef; // keccak256(merchant domain)
        bytes32 approvalRef; // hash of the World ID approval (0 when inside policy)
        bytes32 chargeRef; // keccak256(card transaction id) on settle, reason on refund
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    IERC20Like public immutable usdc;

    address public owner;
    address public operator; // AnyCheckout backend, opens holds within each user's policy
    address public forwarder; // Chainlink KeystoneForwarder (or MockKeystoneForwarder in simulation)
    address public treasury; // receives exactly what each card was charged
    address public messageTransmitter; // CCTP V2 MessageTransmitter on this chain (optional)
    bytes32 public expectedWorkflowId; // optional CRE workflow id check (0 = off)
    address public expectedWorkflowOwner; // optional CRE workflow owner check (0 = off)
    uint64 public settlementGrace; // extra time after a hold expires before anyone can force a refund

    uint256 public totalAccounted; // sum of every available + locked balance

    mapping(address => Account) internal _accounts;
    mapping(bytes32 => Hold) internal _holds;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event Deposited(address indexed user, address indexed from, uint256 amount);
    event BridgedDeposit(address indexed user, uint256 amount, uint32 sourceDomain, bytes32 nonce);
    event Withdrawn(address indexed user, uint256 amount);
    event PolicyUpdated(address indexed user, uint128 weeklyLimit, uint128 perPurchaseLimit, bool agentEnabled);
    event HoldOpened(
        bytes32 indexed holdId,
        address indexed user,
        uint256 amount,
        uint64 expiresAt,
        bool humanApproved,
        bytes32 merchantRef,
        bytes32 approvalRef
    );
    event HoldSettled(
        bytes32 indexed holdId, address indexed user, uint256 charged, uint256 refunded, bytes32 chargeRef
    );
    event HoldRefunded(bytes32 indexed holdId, address indexed user, uint256 amount, bytes32 reason);
    event ConfigUpdated(string key, address value);
    event WorkflowCheckUpdated(bytes32 workflowId, address workflowOwner);
    event SettlementGraceUpdated(uint64 grace);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotOwner();
    error NotOperator();
    error NotForwarder();
    error ZeroAddress();
    error ZeroAmount();
    error AmountTooLarge();
    error InsufficientBalance();
    error AgentDisabled();
    error OverPerPurchaseLimit(uint256 amount, uint256 limit);
    error OverWeeklyLimit(uint256 amount, uint256 remaining);
    error BadTtl();
    error BadHoldId();
    error HoldExists();
    error HoldNotOpen();
    error ChargeExceedsHold(uint256 charged, uint256 amount);
    error NotExpired(uint256 availableAt);
    error BadAction(uint8 action);
    error WrongVault(address vault);
    error BadMetadata();
    error WrongWorkflow();
    error BridgeDisabled();
    error BadBridgeMessage();
    error BridgeFailed();
    error TransferFailed();
    error Reentrancy();

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(
        address usdc_,
        address operator_,
        address forwarder_,
        address treasury_,
        address messageTransmitter_,
        uint64 settlementGrace_
    ) {
        if (usdc_ == address(0) || operator_ == address(0) || forwarder_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20Like(usdc_);
        owner = msg.sender;
        operator = operator_;
        forwarder = forwarder_;
        treasury = treasury_;
        messageTransmitter = messageTransmitter_;
        settlementGrace = settlementGrace_;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------------
    // User actions
    // ------------------------------------------------------------------

    /// @notice Deposit USDC for yourself.
    function deposit(uint256 amount) external nonReentrant {
        _pull(msg.sender, amount);
        _credit(msg.sender, amount);
        emit Deposited(msg.sender, msg.sender, amount);
    }

    /// @notice Deposit USDC for someone else (for example a swap router topping up a user).
    function depositFor(address user, uint256 amount) external nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        _pull(msg.sender, amount);
        _credit(user, amount);
        emit Deposited(user, msg.sender, amount);
    }

    /// @notice Withdraw free balance. Locked funds stay in their holds.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[msg.sender];
        if (a.available < amount) revert InsufficientBalance();
        a.available -= amount;
        totalAccounted -= amount;
        _push(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Set what your agent may spend without asking you.
    /// @param weeklyLimit max autonomous spend per 7-day window (USDC, 6 decimals)
    /// @param perPurchaseLimit max single autonomous purchase (USDC, 6 decimals)
    /// @param agentEnabled kill switch: false blocks every new hold, even human-approved ones
    function setPolicy(uint128 weeklyLimit, uint128 perPurchaseLimit, bool agentEnabled) external {
        Account storage a = _accounts[msg.sender];
        a.weeklyLimit = weeklyLimit;
        a.perPurchaseLimit = perPurchaseLimit;
        a.agentEnabled = agentEnabled;
        emit PolicyUpdated(msg.sender, weeklyLimit, perPurchaseLimit, agentEnabled);
    }

    /// @notice Claim USDC bridged to this vault with CCTP V2 and credit it to the sender.
    /// @dev The burn on the source chain must use mintRecipient = destinationCaller = this vault,
    ///      so nobody else can relay the message. The depositor is the burn's messageSender,
    ///      or the address in hookData (abi.encode(address)) when present.
    ///      Anyone can call this (usually the AnyCheckout relayer); funds always go to the depositor.
    function claimBridgedDeposit(bytes calldata message, bytes calldata attestation)
        external
        nonReentrant
        returns (address user, uint256 minted)
    {
        if (messageTransmitter == address(0)) revert BridgeDisabled();
        if (message.length < MSG_BODY + BODY_HOOK_DATA) revert BadBridgeMessage();

        bytes32 self = bytes32(uint256(uint160(address(this))));
        if (bytes32(message[MSG_DESTINATION_CALLER:MSG_DESTINATION_CALLER + 32]) != self) revert BadBridgeMessage();

        bytes calldata body = message[MSG_BODY:];
        if (bytes32(body[BODY_MINT_RECIPIENT:BODY_MINT_RECIPIENT + 32]) != self) revert BadBridgeMessage();

        user = address(uint160(uint256(bytes32(body[BODY_MESSAGE_SENDER:BODY_MESSAGE_SENDER + 32]))));
        if (body.length >= BODY_HOOK_DATA + 32) {
            address beneficiary = abi.decode(body[BODY_HOOK_DATA:BODY_HOOK_DATA + 32], (address));
            if (beneficiary != address(0)) user = beneficiary;
        }
        if (user == address(0)) revert BadBridgeMessage();

        uint256 before = usdc.balanceOf(address(this));
        if (!IMessageTransmitterV2(messageTransmitter).receiveMessage(message, attestation)) revert BridgeFailed();
        minted = usdc.balanceOf(address(this)) - before;
        if (minted == 0) revert ZeroAmount();

        _credit(user, minted);
        emit BridgedDeposit(
            user,
            minted,
            uint32(bytes4(message[MSG_SOURCE_DOMAIN:MSG_SOURCE_DOMAIN + 4])),
            bytes32(message[MSG_NONCE:MSG_NONCE + 32])
        );
    }

    // ------------------------------------------------------------------
    // Operator actions (AnyCheckout backend, called on behalf of the agent)
    // ------------------------------------------------------------------

    /// @notice Lock funds for one checkout. No user signature needed inside the user's policy.
    /// @param holdId keccak256 of the AnyCheckout intent id
    /// @param ttl seconds until the card should be closed and the hold can expire
    /// @param approvalRef non-zero only after a fresh World ID approval for this exact purchase.
    ///        It lets one purchase go above the policy limits and does not use the weekly allowance.
    function openHold(
        bytes32 holdId,
        address user,
        uint256 amount,
        uint64 ttl,
        bytes32 merchantRef,
        bytes32 approvalRef
    ) external onlyOperator nonReentrant {
        if (holdId == bytes32(0)) revert BadHoldId();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountTooLarge();
        if (ttl < MIN_TTL || ttl > MAX_TTL) revert BadTtl();

        Hold storage h = _holds[holdId];
        if (h.status != HoldStatus.None) revert HoldExists();

        Account storage a = _accounts[user];
        if (!a.agentEnabled) revert AgentDisabled();
        if (a.available < amount) revert InsufficientBalance();

        _roll(a);
        bool human = approvalRef != bytes32(0);
        if (!human) {
            if (amount > a.perPurchaseLimit) revert OverPerPurchaseLimit(amount, a.perPurchaseLimit);
            uint256 remaining = a.weeklyLimit > a.spentInWindow ? a.weeklyLimit - a.spentInWindow : 0;
            if (amount > remaining) revert OverWeeklyLimit(amount, remaining);
            a.spentInWindow += uint128(amount);
        }

        a.available -= amount;
        a.locked += amount;

        h.user = user;
        h.status = HoldStatus.Open;
        h.humanApproved = human;
        h.openedAt = uint64(block.timestamp);
        h.expiresAt = uint64(block.timestamp) + ttl;
        h.amount = amount;
        h.merchantRef = merchantRef;
        h.approvalRef = approvalRef;

        emit HoldOpened(holdId, user, amount, h.expiresAt, human, merchantRef, approvalRef);
    }

    /// @notice Release a hold before any card exists (for example the card issuer refused).
    /// @dev Only ever returns money to the user, so it is safe to give to the operator.
    function cancelHold(bytes32 holdId) external onlyOperator nonReentrant {
        _refund(holdId, REASON_CANCELED);
    }

    // ------------------------------------------------------------------
    // Chainlink CRE settlement
    // ------------------------------------------------------------------

    /// @notice Called by the Chainlink forwarder with a DON-signed report.
    /// @dev report = abi.encode(address vault, uint8 action, bytes32 holdId, uint256 charged, bytes32 ref)
    function onReport(bytes calldata metadata, bytes calldata report) external override nonReentrant {
        if (msg.sender != forwarder) revert NotForwarder();

        if (expectedWorkflowId != bytes32(0) || expectedWorkflowOwner != address(0)) {
            // metadata = workflowId (32) | workflowName (10) | workflowOwner (20) | reportId (2)
            if (metadata.length < 62) revert BadMetadata();
            if (expectedWorkflowId != bytes32(0) && bytes32(metadata[0:32]) != expectedWorkflowId) {
                revert WrongWorkflow();
            }
            if (expectedWorkflowOwner != address(0) && address(bytes20(metadata[42:62])) != expectedWorkflowOwner)
            {
                revert WrongWorkflow();
            }
        }

        (address vault, uint8 action, bytes32 holdId, uint256 charged, bytes32 ref) =
            abi.decode(report, (address, uint8, bytes32, uint256, bytes32));
        if (vault != address(this)) revert WrongVault(vault);

        if (action == ACTION_SETTLE) {
            _settle(holdId, charged, ref);
        } else if (action == ACTION_REFUND) {
            _refund(holdId, ref);
        } else {
            revert BadAction(action);
        }
    }

    /// @notice Safety valve: if no result was reported in time, anyone can refund the user.
    function expireHold(bytes32 holdId) external nonReentrant {
        Hold storage h = _holds[holdId];
        if (h.status != HoldStatus.Open) revert HoldNotOpen();
        uint256 availableAt = uint256(h.expiresAt) + settlementGrace;
        if (block.timestamp < availableAt) revert NotExpired(availableAt);
        _refund(holdId, REASON_TIMEOUT);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getAccount(address user)
        external
        view
        returns (Account memory account, uint256 remainingThisWindow, uint64 windowResetsAt)
    {
        account = _accounts[user];
        if (block.timestamp >= uint256(account.windowStart) + WINDOW) {
            remainingThisWindow = account.weeklyLimit;
            windowResetsAt = 0; // a new window starts with the next purchase
        } else {
            remainingThisWindow =
                account.weeklyLimit > account.spentInWindow ? account.weeklyLimit - account.spentInWindow : 0;
            windowResetsAt = account.windowStart + WINDOW;
        }
    }

    function getHold(bytes32 holdId) external view returns (Hold memory) {
        return _holds[holdId];
    }

    function holdIdFor(string calldata intentId) external pure returns (bytes32) {
        return keccak256(bytes(intentId));
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165Like).interfaceId;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit ConfigUpdated("operator", operator_);
    }

    /// @dev Simulation uses the CRE MockKeystoneForwarder, production the KeystoneForwarder.
    function setForwarder(address forwarder_) external onlyOwner {
        if (forwarder_ == address(0)) revert ZeroAddress();
        forwarder = forwarder_;
        emit ConfigUpdated("forwarder", forwarder_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit ConfigUpdated("treasury", treasury_);
    }

    function setMessageTransmitter(address messageTransmitter_) external onlyOwner {
        messageTransmitter = messageTransmitter_;
        emit ConfigUpdated("messageTransmitter", messageTransmitter_);
    }

    /// @dev Leave both zero while simulating: the MockKeystoneForwarder sends no workflow metadata.
    function setExpectedWorkflow(bytes32 workflowId, address workflowOwner) external onlyOwner {
        expectedWorkflowId = workflowId;
        expectedWorkflowOwner = workflowOwner;
        emit WorkflowCheckUpdated(workflowId, workflowOwner);
    }

    function setSettlementGrace(uint64 grace) external onlyOwner {
        settlementGrace = grace;
        emit SettlementGraceUpdated(grace);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Recover USDC that reached the vault without being credited to anyone
    ///         (for example a CCTP message relayed by someone else). Never touches user funds.
    function sweepSurplus(address to) external onlyOwner nonReentrant returns (uint256 surplus) {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = usdc.balanceOf(address(this));
        surplus = bal > totalAccounted ? bal - totalAccounted : 0;
        if (surplus > 0) _push(to, surplus);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _settle(bytes32 holdId, uint256 charged, bytes32 chargeRef) internal {
        Hold storage h = _holds[holdId];
        if (h.status != HoldStatus.Open) revert HoldNotOpen();
        if (charged > h.amount) revert ChargeExceedsHold(charged, h.amount);

        Account storage a = _accounts[h.user];
        uint256 refund = h.amount - charged;

        h.status = HoldStatus.Settled;
        h.charged = charged;
        h.chargeRef = chargeRef;

        a.locked -= h.amount;
        a.available += refund;
        _releaseAllowance(a, h, refund);

        totalAccounted -= charged;
        if (charged > 0) _push(treasury, charged);

        emit HoldSettled(holdId, h.user, charged, refund, chargeRef);
    }

    function _refund(bytes32 holdId, bytes32 reason) internal {
        Hold storage h = _holds[holdId];
        if (h.status != HoldStatus.Open) revert HoldNotOpen();

        Account storage a = _accounts[h.user];
        h.status = HoldStatus.Refunded;
        h.chargeRef = reason;

        a.locked -= h.amount;
        a.available += h.amount;
        _releaseAllowance(a, h, h.amount);

        emit HoldRefunded(holdId, h.user, h.amount, reason);
    }

    /// @dev Unspent money goes back into the weekly allowance, but only for autonomous holds
    ///      opened in the current window.
    function _releaseAllowance(Account storage a, Hold storage h, uint256 amount) internal {
        if (h.humanApproved || amount == 0 || h.openedAt < a.windowStart) return;
        a.spentInWindow = a.spentInWindow > amount ? a.spentInWindow - uint128(amount) : 0;
    }

    function _roll(Account storage a) internal {
        if (block.timestamp >= uint256(a.windowStart) + WINDOW) {
            a.windowStart = uint64(block.timestamp);
            a.spentInWindow = 0;
        }
    }

    function _credit(address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        _accounts[user].available += amount;
        totalAccounted += amount;
    }

    function _pull(address from, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 before = usdc.balanceOf(address(this));
        if (!usdc.transferFrom(from, address(this), amount)) revert TransferFailed();
        if (usdc.balanceOf(address(this)) - before != amount) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }
}
