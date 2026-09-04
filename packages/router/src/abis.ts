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
  "event Settled(bytes32 indexed orderHash, address indexed seller, address indexed solver, address sellToken, address buyToken, uint256 sellSpent, uint256 buyAmount, uint256 fee)",
  "event OrderTagged(bytes32 indexed orderHash, bytes32 indexed appData)",
  "error OrderExpired()",
  "error NotExclusiveSolver()",
  "error SameToken()",
  "error ZeroAmount()",
  "error InteractionTargetForbidden(address target)",
  "error InteractionFailed(uint256 index, bytes reason)",
  "error LimitNotMet(uint256 received, uint256 minBuyAmount)",
  "error InvalidFee()",
  "error InvalidPermit2()",
]);
/** UniversalRouter, V3/V2 router modules, Permit2 and v4 errors, for decoding the bytes inside InteractionFailed. */
export const routerErrorsAbi = parseAbi([
  "error V3TooLittleReceived()", "error V3InvalidSwap()", "error V3InvalidCaller()", "error V3InvalidAmountOut()", "error V3TooMuchRequestedPerHop(uint256,uint256,uint256)",
  "error V2TooLittleReceived()", "error V2InvalidPath()", "error InvalidCommandType(uint256)", "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error TransactionDeadlinePassed()", "error InsufficientToken()", "error InsufficientETH()", "error SliceOutOfBounds()", "error LengthMismatch()", "error BalanceTooLow()",
  "error InvalidSigner()", "error SignatureExpired(uint256)", "error InvalidNonce()", "error InvalidSignatureLength()",
  "error CurrencyNotSettled()", "error DeltaNotPositive(address)", "error DeltaNotNegative(address)", "error NotPoolManager()",
]);
export const poolManagerInitializeEvent = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

/**
 * Every custom error a Quiver fill can revert with: the settlement contract's own, the UniversalRouter's
 * (including Robinhood Chain's per-hop price guards), Permit2's, and v4's. Decoding a failed simulation
 * against this tells a solver operator which leg failed instead of an opaque 4-byte selector.
 */
export const routerErrorsAbi = parseAbi([
  // QuiverSettlement
  "error InteractionFailed(uint256 index, bytes reason)",
  "error InteractionTargetForbidden(address target)",
  "error LimitNotMet(uint256 received, uint256 minBuyAmount)",
  "error OrderExpired()",
  "error NotExclusiveSolver()",
  "error SameToken()",
  "error ZeroAmount()",
  "error InvalidPermit2()",
  "error InvalidFee()",
  // UniversalRouter
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error InvalidCommandType(uint256 commandType)",
  "error SliceOutOfBounds()",
  "error TransactionDeadlinePassed()",
  "error LengthMismatch()",
  "error InvalidEthSender()",
  "error BalanceTooLow()",
  "error InsufficientToken()",
  "error InsufficientETH()",
  // Uniswap v2/v3 modules
  "error V2TooLittleReceived()",
  "error V2InvalidPath()",
  "error V3TooLittleReceived()",
  "error V3TooMuchRequested()",
  "error V3InvalidSwap()",
  "error V3InvalidCaller()",
  "error V3InvalidAmountOut()",
  "error V3TooMuchRequestedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)",
  // Permit2
  "error InvalidSigner()",
  "error InvalidNonce()",
  "error SignatureExpired(uint256 signatureDeadline)",
  "error InvalidSignatureLength()",
  "error InvalidContractSignature()",
  // v4
  "error CurrencyNotSettled()",
  "error DeltaNotPositive(address currency)",
  "error DeltaNotNegative(address currency)",
  "error NotPoolManager()",
  "error UnsafeCast()",
]);
