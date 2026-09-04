// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISignatureTransfer} from "permit2/interfaces/ISignatureTransfer.sol";

/**
 * @title QuiverSettlement
 * @notice Intent settlement for Robinhood Chain. A seller signs ONE Permit2 witness transfer whose witness
 *         is the order: what they sell, the least they accept, who receives it, and which solver (if any)
 *         holds exclusivity until when. A solver submits the order with arbitrary interactions (DEX calls).
 *         The contract pulls the sell tokens, runs the interactions, and enforces the seller's limit on the
 *         buy-token balance delta. Everything delivered goes to the receiver; unspent sell tokens go back to
 *         the seller; the solver keeps whatever margin it routed to itself inside the interactions.
 *
 *         No owner, no upgrade, no allowlist. The only trust assumption is Permit2.
 */
contract QuiverSettlement is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Order {
        address seller;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 minBuyAmount;
        address receiver;
        uint256 deadline;
        address exclusiveSolver;
        uint256 exclusiveUntil;
        bytes32 appData;
    }

    struct Interaction {
        address target;
        uint256 value;
        bytes data;
    }

    string public constant WITNESS_TYPE_STRING =
        "Order witness)Order(address seller,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,address receiver,uint256 deadline,address exclusiveSolver,uint256 exclusiveUntil,bytes32 appData)TokenPermissions(address token,uint256 amount)";
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address seller,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,address receiver,uint256 deadline,address exclusiveSolver,uint256 exclusiveUntil,bytes32 appData)"
    );
    uint256 public constant MAX_FEE_BPS = 30;

    ISignatureTransfer public immutable PERMIT2;
    uint256 public immutable feeBps;
    address public immutable feeRecipient;

    /// @notice One per settlement. sellAmount, receiver and appData are in the order (see OrderTagged for appData).
    event Settled(
        bytes32 indexed orderHash,
        address indexed seller,
        address indexed solver,
        address sellToken,
        address buyToken,
        uint256 sellSpent,
        uint256 buyAmount,
        uint256 fee
    );
    /// @notice Attribution tag for integrators, indexed so a frontend can find its own fills.
    event OrderTagged(bytes32 indexed orderHash, bytes32 indexed appData);

    error InvalidPermit2();
    error InvalidFee();
    error OrderExpired();
    error NotExclusiveSolver();
    error PermitMismatch();
    error SameToken();
    error ZeroAmount();
    error InteractionTargetForbidden(address target);
    error InteractionFailed(uint256 index, bytes reason);
    error LimitNotMet(uint256 received, uint256 minBuyAmount);

    constructor(address permit2_, uint256 feeBps_, address feeRecipient_) {
        if (permit2_ == address(0)) revert InvalidPermit2();
        if (feeBps_ > MAX_FEE_BPS || (feeBps_ > 0 && feeRecipient_ == address(0))) revert InvalidFee();
        PERMIT2 = ISignatureTransfer(permit2_);
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    /**
     * @notice Settle one order.
     * @param order        The seller's intent (the Permit2 witness).
     * @param permitNonce  Permit2 unordered nonce the seller used. Cancelling an order = invalidating this nonce.
     * @param permitDeadline Permit2 signature deadline (independent of order.deadline; both must hold).
     * @param signature    Seller's Permit2 PermitWitnessTransferFrom signature with this contract as spender.
     * @param interactions Calls the solver wants executed from this contract between pull and payout.
     * @return buyAmount   What the receiver got, after the protocol fee.
     */
    function settle(
        Order calldata order,
        uint256 permitNonce,
        uint256 permitDeadline,
        bytes calldata signature,
        Interaction[] calldata interactions
    ) external payable nonReentrant returns (uint256 buyAmount) {
        _checkOrder(order);
        bytes32 orderHash = hashOrder(order);
        uint256 sellBefore = IERC20(order.sellToken).balanceOf(address(this));
        uint256 buyBefore = IERC20(order.buyToken).balanceOf(address(this));

        _pull(order, orderHash, permitNonce, permitDeadline, signature);
        _execute(interactions);

        uint256 fee;
        (buyAmount, fee) = _payout(order, buyBefore);
        uint256 unspent = _refundUnspent(order, sellBefore);

        emit Settled(orderHash, order.seller, msg.sender, order.sellToken, order.buyToken, order.sellAmount - unspent, buyAmount, fee);
        if (order.appData != bytes32(0)) emit OrderTagged(orderHash, order.appData);
    }

    function _checkOrder(Order calldata order) internal view {
        if (block.timestamp > order.deadline) revert OrderExpired();
        if (order.sellToken == order.buyToken) revert SameToken();
        if (order.sellAmount == 0) revert ZeroAmount();
        if (order.exclusiveSolver != address(0) && block.timestamp <= order.exclusiveUntil && msg.sender != order.exclusiveSolver) {
            revert NotExclusiveSolver();
        }
    }

    function _pull(Order calldata order, bytes32 orderHash, uint256 permitNonce, uint256 permitDeadline, bytes calldata signature) internal {
        PERMIT2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: order.sellToken, amount: order.sellAmount}),
                nonce: permitNonce,
                deadline: permitDeadline
            }),
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: order.sellAmount}),
            order.seller,
            orderHash,
            WITNESS_TYPE_STRING,
            signature
        );
    }

    function _execute(Interaction[] calldata interactions) internal {
        for (uint256 i = 0; i < interactions.length; i++) {
            Interaction calldata ix = interactions[i];
            if (ix.target == address(PERMIT2)) revert InteractionTargetForbidden(ix.target);
            (bool ok, bytes memory ret) = ix.target.call{value: ix.value}(ix.data);
            if (!ok) revert InteractionFailed(i, ret);
        }
    }

    function _payout(Order calldata order, uint256 buyBefore) internal returns (uint256 buyAmount, uint256 fee) {
        IERC20 buyToken = IERC20(order.buyToken);
        uint256 received = buyToken.balanceOf(address(this)) - buyBefore;
        if (received < order.minBuyAmount) revert LimitNotMet(received, order.minBuyAmount);
        fee = (received * feeBps) / 10_000;
        buyAmount = received - fee;
        if (fee > 0) buyToken.safeTransfer(feeRecipient, fee);
        buyToken.safeTransfer(order.receiver, buyAmount);
    }

    function _refundUnspent(Order calldata order, uint256 sellBefore) internal returns (uint256 unspent) {
        IERC20 sellToken = IERC20(order.sellToken);
        uint256 sellAfter = sellToken.balanceOf(address(this));
        unspent = sellAfter > sellBefore ? sellAfter - sellBefore : 0;
        if (unspent > 0) sellToken.safeTransfer(order.seller, unspent);
    }

    /// @notice EIP-712 struct hash of an order, which is also the Permit2 witness.
    function hashOrder(Order calldata order) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.seller,
                order.sellToken,
                order.buyToken,
                order.sellAmount,
                order.minBuyAmount,
                order.receiver,
                order.deadline,
                order.exclusiveSolver,
                order.exclusiveUntil,
                order.appData
            )
        );
    }

    receive() external payable {}
}
