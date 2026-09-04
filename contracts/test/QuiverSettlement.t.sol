// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ISignatureTransfer} from "permit2/interfaces/ISignatureTransfer.sol";
import {QuiverSettlement} from "../src/QuiverSettlement.sol";
import {MockDex, TestToken} from "../src/test/MockDex.sol";

contract QuiverSettlementTest is Test {
    address internal constant PERMIT2_ADDR = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    ISignatureTransfer internal permit2;
    QuiverSettlement internal settlement;
    QuiverSettlement internal feeSettlement;
    MockDex internal dex;
    TestToken internal weth;
    TestToken internal usdg;

    uint256 internal sellerKey = 0x5E11E4;
    address internal seller;
    address internal solver = makeAddr("solver");
    address internal otherSolver = makeAddr("otherSolver");
    address internal feeRecipient = makeAddr("fees");

    function setUp() public {
        vm.etch(PERMIT2_ADDR, vm.parseBytes(vm.readFile("test/deps/Permit2.runtime.hex")));
        permit2 = ISignatureTransfer(PERMIT2_ADDR);
        settlement = new QuiverSettlement(PERMIT2_ADDR, 0, address(0));
        feeSettlement = new QuiverSettlement(PERMIT2_ADDR, 10, feeRecipient);
        dex = new MockDex();
        weth = new TestToken("Wrapped Ether", "WETH", 18);
        usdg = new TestToken("Global Dollar", "USDG", 6);
        seller = vm.addr(sellerKey);
        weth.mint(seller, 10 ether);
        usdg.mint(address(dex), 1e36);
        vm.prank(seller);
        weth.approve(PERMIT2_ADDR, type(uint256).max);
    }

    function _order(uint256 minBuy, address exclusive, uint256 exclusiveUntil) internal view returns (QuiverSettlement.Order memory) {
        return QuiverSettlement.Order({
            seller: seller,
            sellToken: address(weth),
            buyToken: address(usdg),
            sellAmount: 1 ether,
            minBuyAmount: minBuy,
            receiver: seller,
            deadline: block.timestamp + 10 minutes,
            exclusiveSolver: exclusive,
            exclusiveUntil: exclusiveUntil,
            appData: keccak256("quiver:test")
        });
    }

    function _sign(QuiverSettlement s, QuiverSettlement.Order memory o, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 orderHash = keccak256(
            abi.encode(s.ORDER_TYPEHASH(), o.seller, o.sellToken, o.buyToken, o.sellAmount, o.minBuyAmount, o.receiver, o.deadline, o.exclusiveSolver, o.exclusiveUntil, o.appData)
        );
        bytes32 permitTypehash = keccak256(
            abi.encodePacked("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,", s.WITNESS_TYPE_STRING())
        );
        bytes32 tokenPermissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, o.sellToken, o.sellAmount));
        bytes32 structHash = keccak256(abi.encode(permitTypehash, tokenPermissions, address(s), nonce, deadline, orderHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", permit2.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(sellerKey, digest);
        return abi.encodePacked(r, sv, v);
    }

    /// Interactions a solver would build: approve the DEX, swap with output to the settlement contract.
    function _swapVia(QuiverSettlement s, uint256 amountIn, uint256 rateBps) internal view returns (QuiverSettlement.Interaction[] memory ix) {
        ix = new QuiverSettlement.Interaction[](2);
        ix[0] = QuiverSettlement.Interaction(address(weth), 0, abi.encodeWithSelector(weth.approve.selector, address(dex), amountIn));
        ix[1] = QuiverSettlement.Interaction(address(dex), 0, abi.encodeWithSelector(dex.swap.selector, address(weth), address(usdg), amountIn, rateBps, address(s)));
    }

    function test_settleDeliversEverythingReceived() public {
        // 1 WETH at 2500 USDG per WETH: rate 2500e6 / 1e18 expressed in bps of input is awkward, so use a 6-decimal-aware rate:
        // MockDex pays amountIn * rateBps / 10000; with amountIn = 1e18 and rateBps = 25, out = 2.5e15 USDG atomic = 2.5e9 USDG. Use minBuy accordingly.
        QuiverSettlement.Order memory o = _order(2_000_000_000_000_000, address(0), 0);
        bytes memory sig = _sign(settlement, o, 1, block.timestamp + 1 hours);
        vm.prank(solver);
        uint256 got = settlement.settle(o, 1, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, 25));
        assertEq(got, 2_500_000_000_000_000);
        assertEq(usdg.balanceOf(seller), 2_500_000_000_000_000);
        assertEq(weth.balanceOf(seller), 9 ether);
        assertEq(weth.balanceOf(address(settlement)), 0);
    }

    function test_limitEnforced() public {
        QuiverSettlement.Order memory o = _order(3_000_000_000_000_000, address(0), 0);
        bytes memory sig = _sign(settlement, o, 2, block.timestamp + 1 hours);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(QuiverSettlement.LimitNotMet.selector, 2_500_000_000_000_000, 3_000_000_000_000_000));
        settlement.settle(o, 2, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, 25));
        assertEq(weth.balanceOf(seller), 10 ether);
    }

    function test_unspentSellTokensReturned() public {
        QuiverSettlement.Order memory o = _order(1_000_000_000_000_000, address(0), 0);
        bytes memory sig = _sign(settlement, o, 3, block.timestamp + 1 hours);
        // Solver only needs half the input to satisfy the limit; the other half must go back to the seller.
        vm.prank(solver);
        settlement.settle(o, 3, block.timestamp + 1 hours, sig, _swapVia(settlement, 0.5 ether, 25));
        assertEq(weth.balanceOf(seller), 9.5 ether);
        assertEq(usdg.balanceOf(seller), 1_250_000_000_000_000);
    }

    function test_exclusivityWindow() public {
        QuiverSettlement.Order memory o = _order(2_000_000_000_000_000, solver, block.timestamp + 30);
        bytes memory sig = _sign(settlement, o, 4, block.timestamp + 1 hours);
        vm.prank(otherSolver);
        vm.expectRevert(QuiverSettlement.NotExclusiveSolver.selector);
        settlement.settle(o, 4, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, 25));
        vm.warp(block.timestamp + 31);
        vm.prank(otherSolver);
        settlement.settle(o, 4, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, 25));
        assertEq(usdg.balanceOf(seller), 2_500_000_000_000_000);
    }

    function test_replayRejectedByPermit2Nonce() public {
        QuiverSettlement.Order memory o = _order(2_000_000_000_000_000, address(0), 0);
        bytes memory sig = _sign(settlement, o, 5, block.timestamp + 1 hours);
        vm.prank(solver);
        settlement.settle(o, 5, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, 25));
        vm.prank(solver);
        vm.expectRevert();
        settlement.settle(o, 5, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, 25));
    }

    function test_cancelByInvalidatingNonce() public {
        QuiverSettlement.Order memory o = _order(2_000_000_000_000_000, address(0), 0);
        bytes memory sig = _sign(settlement, o, 6, block.timestamp + 1 hours);
        vm.prank(seller);
        permit2.invalidateUnorderedNonces(0, 1 << 6);
        vm.prank(solver);
        vm.expectRevert();
        settlement.settle(o, 6, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, 25));
    }

    function test_tamperedOrderRejected() public {
        QuiverSettlement.Order memory o = _order(2_000_000_000_000_000, address(0), 0);
        bytes memory sig = _sign(settlement, o, 7, block.timestamp + 1 hours);
        o.receiver = solver; // solver tries to redirect the payout
        vm.prank(solver);
        vm.expectRevert();
        settlement.settle(o, 7, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, 25));
    }

    function test_expiredOrderRejected() public {
        QuiverSettlement.Order memory o = _order(2_000_000_000_000_000, address(0), 0);
        bytes memory sig = _sign(settlement, o, 8, block.timestamp + 1 hours);
        vm.warp(o.deadline + 1);
        vm.prank(solver);
        vm.expectRevert(QuiverSettlement.OrderExpired.selector);
        settlement.settle(o, 8, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, 25));
    }

    function test_interactionCannotTargetPermit2() public {
        QuiverSettlement.Order memory o = _order(1, address(0), 0);
        bytes memory sig = _sign(settlement, o, 9, block.timestamp + 1 hours);
        QuiverSettlement.Interaction[] memory ix = new QuiverSettlement.Interaction[](1);
        ix[0] = QuiverSettlement.Interaction(PERMIT2_ADDR, 0, hex"");
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(QuiverSettlement.InteractionTargetForbidden.selector, PERMIT2_ADDR));
        settlement.settle(o, 9, block.timestamp + 1 hours, sig, ix);
    }

    function test_feeTakenFromReceived() public {
        QuiverSettlement.Order memory o = _order(2_000_000_000_000_000, address(0), 0);
        bytes memory sig = _sign(feeSettlement, o, 10, block.timestamp + 1 hours);
        vm.prank(solver);
        uint256 got = feeSettlement.settle(o, 10, block.timestamp + 1 hours, sig, _swapVia(feeSettlement, 1 ether, 25));
        assertEq(usdg.balanceOf(feeRecipient), 2_500_000_000_000);
        assertEq(got, 2_497_500_000_000_000);
    }

    function testFuzz_solverCannotKeepBuyTokensFromThisOrder(uint256 rateBps) public {
        rateBps = bound(rateBps, 1, 100);
        uint256 expected = (1 ether * rateBps) / 10_000;
        QuiverSettlement.Order memory o = _order(expected, address(0), 0);
        bytes memory sig = _sign(settlement, o, 11, block.timestamp + 1 hours);
        vm.prank(solver);
        settlement.settle(o, 11, block.timestamp + 1 hours, sig, _swapVia(settlement, 1 ether, rateBps));
        assertEq(usdg.balanceOf(seller), expected);
        assertEq(usdg.balanceOf(address(settlement)), 0);
        assertEq(usdg.balanceOf(solver), 0);
    }
}
