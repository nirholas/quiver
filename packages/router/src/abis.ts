import { parseAbi } from "viem";

export const uniswapV2FactoryAbi = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address pair)"]);
export const uniswapV2PairAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
export const uniswapV3FactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);
export const uniswapV3PoolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
export const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
export const v4StateViewAbi = parseAbi([
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
export const swapRouter02Abi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable returns (uint256 amountOut)",
]);
export const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
export const settlementAbi = parseAbi([
  "struct Order { address seller; address sellToken; address buyToken; uint256 sellAmount; uint256 minBuyAmount; address receiver; uint256 deadline; address exclusiveSolver; uint256 exclusiveUntil; bytes32 appData; }",
  "struct Interaction { address target; uint256 value; bytes data; }",
  "function settle(Order order, uint256 permitNonce, uint256 permitDeadline, bytes signature, Interaction[] interactions) payable returns (uint256 buyAmount)",
  "function hashOrder(Order order) pure returns (bytes32)",
  "function PERMIT2() view returns (address)",
  "function feeBps() view returns (uint256)",
  "event Settled(bytes32 indexed orderHash, address indexed seller, address indexed solver, address sellToken, address buyToken, uint256 sellAmount, uint256 sellSpent, uint256 buyAmount, uint256 fee, address receiver, bytes32 appData)",
]);
export const poolManagerInitializeEvent = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
