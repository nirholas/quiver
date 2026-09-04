/** Robinhood Chain mainnet (eip155:4663) addresses. Every one was read from the chain on 2026-09-03. */
export const CHAIN_ID = 4663;
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
export const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as const;

/** Uniswap v2 (factory read from a live pair's factory()). */
export const UNISWAP_V2_FACTORY = "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f" as const;
/** Uniswap v3 (developers.uniswap.org deployments, verified to hold code). */
export const UNISWAP_V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as const;
export const UNISWAP_V3_QUOTER_V2 = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as const;
export const UNISWAP_SWAP_ROUTER_02 = "0xCaf681a66D020601342297493863E78C959E5cb2" as const;
export const UNISWAP_UNIVERSAL_ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904" as const;
export const UNISWAP_V3_TICK_LENS = "0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468" as const;
/** Uniswap v4. */
export const UNISWAP_V4_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;
export const UNISWAP_V4_QUOTER = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94" as const;
export const UNISWAP_V4_STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as const;
export const UNISWAP_V4_POSITION_MANAGER = "0x58daec3116aae6D93017bAAea7749052E8a04fA7" as const;

export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

export type TokenInfo = { address: `0x${string}`; symbol: string; name: string; decimals: number };

export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

/** The liquid tokens on the chain by holder count. Routing uses WETH and USDG as intermediate hops. */
export const TOKENS: TokenInfo[] = [
  { address: WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
  { address: USDG, symbol: "USDG", name: "Global Dollar", decimals: 6 },
  { address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", symbol: "USDe", name: "Ethena USDe", decimals: 18 },
  { address: "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4", symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8 },
  { address: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", symbol: "VIRTUAL", name: "Virtual Protocol", decimals: 18 },
  { address: "0x39dBED3a2bd333467115dE45665cC57F813C4571", symbol: "PONS", name: "PONS", decimals: 18 },
  { address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", symbol: "CASHCAT", name: "CASHCAT", decimals: 18 },
  { address: "0x74BE72AFFAFbC8de30F0C11247814036314D625f", symbol: "PENGU", name: "Pudgy Penguins", decimals: 18 },
  { address: "0x8f86a15EC17cb3369d8b3E666dAdBC11daA82b79", symbol: "APE", name: "ApeCoin", decimals: 18 },
  { address: "0x492641F648a4986844848E0beFE66D14817bCE34", symbol: "LINK", name: "Chainlink", decimals: 18 },
  { address: "0x0bb40D7fbaE7f0C69Bc5910C601987dce697d85F", symbol: "SUSHI", name: "SushiToken", decimals: 18 },
  { address: "0x1755C2910c126eE1b0CF1E08a307Dc9E787285a0", symbol: "1INCH", name: "1inch", decimals: 18 },
];

export const INTERMEDIATES: readonly `0x${string}`[] = [WETH, USDG];

export function tokenBySymbol(symbol: string): TokenInfo | undefined {
  return TOKENS.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
}
