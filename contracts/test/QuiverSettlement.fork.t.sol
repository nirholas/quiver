// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISignatureTransfer} from "permit2/interfaces/ISignatureTransfer.sol";
import {QuiverSettlement} from "../src/QuiverSettlement.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// @dev Live Robinhood Chain fork: real Permit2, real WETH and USDG, real Uniswap v3 pool through SwapRouter02.
contract QuiverSettlementForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SWAP_ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant QUOTER_V2 = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    QuiverSettlement settlement;
    uint256 sellerKey = 0x5E11E4;
    address seller;
    address solver = makeAddr("solver");

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        settlement = new QuiverSettlement(PERMIT2, 0, address(0));
        seller = vm.addr(sellerKey);
        deal(WETH, seller, 1 ether);
        vm.prank(seller);
        IERC20(WETH).approve(PERMIT2, type(uint256).max);
    }

    function test_fork_sellWethForUsdgThroughUniswapV3() public {
        if (address(settlement) == address(0)) return;
        (uint256 quoted,,,) = IQuoterV2(QUOTER_V2).quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({tokenIn: WETH, tokenOut: USDG, amountIn: 0.1 ether, fee: 500, sqrtPriceLimitX96: 0})
        );
        assertGt(quoted, 100e6, "quote should be worth more than 100 USDG");

        QuiverSettlement.Order memory o = QuiverSettlement.Order({
            seller: seller,
            sellToken: WETH,
            buyToken: USDG,
            sellAmount: 0.1 ether,
            minBuyAmount: (quoted * 995) / 1000,
            receiver: seller,
            deadline: block.timestamp + 10 minutes,
            exclusiveSolver: solver,
            exclusiveUntil: block.timestamp + 30,
            appData: keccak256("quiver:fork")
        });
        bytes memory sig = _sign(o, 1, block.timestamp + 1 hours);

        QuiverSettlement.Interaction[] memory ix = new QuiverSettlement.Interaction[](2);
        ix[0] = QuiverSettlement.Interaction(WETH, 0, abi.encodeWithSelector(IERC20.approve.selector, SWAP_ROUTER02, 0.1 ether));
        ix[1] = QuiverSettlement.Interaction(
            SWAP_ROUTER02,
            0,
            abi.encodeWithSelector(
                ISwapRouter02.exactInputSingle.selector,
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: WETH, tokenOut: USDG, fee: 500, recipient: address(settlement), amountIn: 0.1 ether, amountOutMinimum: o.minBuyAmount, sqrtPriceLimitX96: 0
                })
            )
        );
        vm.prank(solver);
        uint256 got = settlement.settle(o, 1, block.timestamp + 1 hours, sig, ix);
        assertEq(got, quoted, "settlement should deliver exactly the quoted amount");
        assertEq(IERC20(USDG).balanceOf(seller), quoted);
        assertEq(IERC20(WETH).balanceOf(seller), 0.9 ether);
    }

    function _sign(QuiverSettlement.Order memory o, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 orderHash = keccak256(
            abi.encode(settlement.ORDER_TYPEHASH(), o.seller, o.sellToken, o.buyToken, o.sellAmount, o.minBuyAmount, o.receiver, o.deadline, o.exclusiveSolver, o.exclusiveUntil, o.appData)
        );
        bytes32 permitTypehash = keccak256(
            abi.encodePacked("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,", settlement.WITNESS_TYPE_STRING())
        );
        bytes32 tokenPermissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, o.sellToken, o.sellAmount));
        bytes32 structHash = keccak256(abi.encode(permitTypehash, tokenPermissions, address(settlement), nonce, deadline, orderHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
