import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import {
  INTERMEDIATES, MULTICALL3, UNISWAP_V2_FACTORY, UNISWAP_V3_FACTORY, UNISWAP_V3_QUOTER_V2, UNISWAP_V4_QUOTER, UNISWAP_V4_STATE_VIEW, V3_FEE_TIERS,
} from "./addresses.js";
import { quoterV2Abi, uniswapV2FactoryAbi, uniswapV2PairAbi, uniswapV3FactoryAbi, v4QuoterAbi, v4StateViewAbi } from "./abis.js";
import { v2AmountOut, v2ImpactBps } from "./v2.js";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

export type Hop =
  | { venue: "uniswap-v2"; pool: Address; tokenIn: Address; tokenOut: Address }
  | { venue: "uniswap-v3"; pool: Address; fee: number; tokenIn: Address; tokenOut: Address }
  | { venue: "uniswap-v4"; poolId: Hex; poolKey: PoolKey; tokenIn: Address; tokenOut: Address };

export type Route = { hops: Hop[]; amountIn: bigint; amountOut: bigint; gasEstimate: bigint };

/** A quote is one or more routes that together consume `amountIn`. */
export type Quote = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  routes: Route[];
  /** Best single-venue, single-hop output, for showing the aggregation edge. */
  bestDirect?: { venue: Hop["venue"]; amountOut: bigint };
  blockNumber: bigint;
  quotedAt: number;
};

export type QuoteOptions = {
  /** Candidate v4 pool keys for the pair (discovered via PoolManager Initialize logs). */
  v4Pools?: PoolKey[];
  /** Try splitting the input across the two best routes at these percentages. Default [50, 25, 75]. */
  splits?: number[];
  /** Skip 2-hop routes through WETH/USDG. */
  directOnly?: boolean;
};

type Call = { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] };
type MulticallResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };
function resultOf(r: MulticallResult | undefined): unknown {
  return r && r.status === "success" ? r.result : undefined;
}

const V2_GAS = 110_000n;
const V3_GAS = 130_000n;
const V4_GAS = 150_000n;

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

function sortTokens(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/** Every single-hop candidate between two tokens, quoted on-chain in one multicall batch. */
export async function quoteSingleHops(client: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint, v4Pools: PoolKey[] = []): Promise<Route[]> {
  tokenIn = getAddress(tokenIn);
  tokenOut = getAddress(tokenOut);
  const routes: Route[] = [];

  // Discover pools (v2 pair + v3 pools per fee tier) in one multicall.
  const discoveryCalls: Call[] = [
    { address: UNISWAP_V2_FACTORY, abi: uniswapV2FactoryAbi, functionName: "getPair", args: [tokenIn, tokenOut] },
    ...V3_FEE_TIERS.map((fee): Call => ({ address: UNISWAP_V3_FACTORY, abi: uniswapV3FactoryAbi, functionName: "getPool", args: [tokenIn, tokenOut, fee] })),
  ];
  const discovery = (await client.multicall({ allowFailure: true, multicallAddress: MULTICALL3, contracts: discoveryCalls as never })) as MulticallResult[];
  const zero = "0x0000000000000000000000000000000000000000";
  const v2Pair = (resultOf(discovery[0]) as Address | undefined) ?? zero;
  const v3Pools = V3_FEE_TIERS.map((fee, i) => ({ fee, pool: (resultOf(discovery[i + 1]) as Address | undefined) ?? zero })).filter((p) => p.pool !== zero);

  const calls: Call[] = [];
  const tags: Array<{ kind: "v2" | "v3" | "v4"; i: number }> = [];
  if (v2Pair !== zero) {
    calls.push({ address: v2Pair, abi: uniswapV2PairAbi, functionName: "getReserves", args: [] });
    calls.push({ address: v2Pair, abi: uniswapV2PairAbi, functionName: "token0", args: [] });
    tags.push({ kind: "v2", i: 0 }, { kind: "v2", i: 1 });
  }
  v3Pools.forEach((p, i) => {
    calls.push({ address: UNISWAP_V3_QUOTER_V2, abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee: p.fee, sqrtPriceLimitX96: 0n }] });
    tags.push({ kind: "v3", i });
  });
  const usableV4 = v4Pools.filter((k) => {
    const [a, b] = sortTokens(tokenIn, tokenOut);
    return k.currency0.toLowerCase() === a.toLowerCase() && k.currency1.toLowerCase() === b.toLowerCase();
  });
  usableV4.forEach((k, i) => {
    const zeroForOne = tokenIn.toLowerCase() === k.currency0.toLowerCase();
    calls.push({ address: UNISWAP_V4_QUOTER, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: k, zeroForOne, exactAmount: amountIn, hookData: "0x" }] });
    tags.push({ kind: "v4", i });
  });
  if (calls.length === 0) return routes;

  const results = (await client.multicall({ allowFailure: true, multicallAddress: MULTICALL3, contracts: calls as never })) as MulticallResult[];

  let v2Reserves: { r0: bigint; r1: bigint } | undefined;
  let v2Token0: Address | undefined;
  results.forEach((res, idx) => {
    const tag = tags[idx]!;
    if (res.status !== "success") return;
    if (tag.kind === "v2") {
      if (tag.i === 0) {
        const [r0, r1] = res.result as [bigint, bigint, number];
        v2Reserves = { r0, r1 };
      } else {
        v2Token0 = res.result as Address;
      }
    } else if (tag.kind === "v3") {
      const [amountOut, , , gas] = res.result as [bigint, bigint, number, bigint];
      if (amountOut > 0n) {
        routes.push({ hops: [{ venue: "uniswap-v3", pool: v3Pools[tag.i]!.pool, fee: v3Pools[tag.i]!.fee, tokenIn, tokenOut }], amountIn, amountOut, gasEstimate: gas + 50_000n });
      }
    } else {
      const [amountOut, gas] = res.result as [bigint, bigint];
      const key = usableV4[tag.i]!;
      if (amountOut > 0n) {
        routes.push({ hops: [{ venue: "uniswap-v4", poolId: poolId(key), poolKey: key, tokenIn, tokenOut }], amountIn, amountOut, gasEstimate: gas + 60_000n });
      }
    }
  });
  if (v2Reserves && v2Token0) {
    const inIs0 = v2Token0.toLowerCase() === tokenIn.toLowerCase();
    const reserveIn = inIs0 ? v2Reserves.r0 : v2Reserves.r1;
    const reserveOut = inIs0 ? v2Reserves.r1 : v2Reserves.r0;
    const amountOut = v2AmountOut(amountIn, reserveIn, reserveOut);
    if (amountOut > 0n && v2ImpactBps(amountIn, reserveIn, reserveOut) < 9_000) {
      routes.push({ hops: [{ venue: "uniswap-v2", pool: v2Pair, tokenIn, tokenOut }], amountIn, amountOut, gasEstimate: V2_GAS });
    }
  }
  return routes.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
}

/**
 * Best route set for tokenIn -> tokenOut: direct single hops, two-hop paths through WETH/USDG, and a
 * split of the input across the two best distinct routes when that beats either alone.
 */
export async function quote(client: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint, opts: QuoteOptions = {}): Promise<Quote> {
  tokenIn = getAddress(tokenIn);
  tokenOut = getAddress(tokenOut);
  const blockNumber = await client.getBlockNumber();
  const candidates: Route[] = [];

  const direct = await quoteSingleHops(client, tokenIn, tokenOut, amountIn, opts.v4Pools);
  candidates.push(...direct);

  if (!opts.directOnly) {
    const mids = INTERMEDIATES.filter((m) => m.toLowerCase() !== tokenIn.toLowerCase() && m.toLowerCase() !== tokenOut.toLowerCase());
    for (const mid of mids) {
      const first = await quoteSingleHops(client, tokenIn, mid, amountIn, opts.v4Pools);
      if (first.length === 0) continue;
      const best1 = first[0]!;
      const second = await quoteSingleHops(client, mid, tokenOut, best1.amountOut, opts.v4Pools);
      if (second.length === 0) continue;
      const best2 = second[0]!;
      candidates.push({ hops: [...best1.hops, ...best2.hops], amountIn, amountOut: best2.amountOut, gasEstimate: best1.gasEstimate + best2.gasEstimate });
    }
  }

  candidates.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
  let routes: Route[] = candidates.length ? [candidates[0]!] : [];
  let amountOut = routes[0]?.amountOut ?? 0n;

  // Split search: re-quote the two best distinct single-hop directs at each split and keep the best total.
  const distinctDirect = direct.filter((r, i, arr) => arr.findIndex((x) => routeKey(x) === routeKey(r)) === i);
  if (distinctDirect.length >= 2) {
    const [a, b] = [distinctDirect[0]!, distinctDirect[1]!];
    for (const pct of opts.splits ?? [50, 25, 75]) {
      const inA = (amountIn * BigInt(pct)) / 100n;
      const inB = amountIn - inA;
      const [qa, qb] = await Promise.all([
        quoteSingleHops(client, tokenIn, tokenOut, inA, opts.v4Pools),
        quoteSingleHops(client, tokenIn, tokenOut, inB, opts.v4Pools),
      ]);
      const ra = qa.find((r) => routeKey(r) === routeKey(a));
      const rb = qb.find((r) => routeKey(r) === routeKey(b));
      if (!ra || !rb) continue;
      const total = ra.amountOut + rb.amountOut;
      if (total > amountOut) {
        amountOut = total;
        routes = [ra, rb];
      }
    }
  }

  return {
    tokenIn, tokenOut, amountIn, amountOut, routes,
    bestDirect: direct[0] ? { venue: direct[0].hops[0]!.venue, amountOut: direct[0].amountOut } : undefined,
    blockNumber, quotedAt: Math.floor(Date.now() / 1000),
  };
}

export function routeKey(r: Route): string {
  return r.hops.map((h) => (h.venue === "uniswap-v4" ? `v4:${h.poolId}` : h.venue === "uniswap-v3" ? `v3:${h.pool}` : `v2:${h.pool}`)).join(">");
}

/** Discover v4 pools for a token pair from PoolManager Initialize logs, checking they still hold liquidity. */
export async function discoverV4Pools(client: PublicClient, poolManager: Address, tokenA: Address, tokenB: Address, fromBlock: bigint, toBlock: bigint | "latest" = "latest"): Promise<PoolKey[]> {
  const [c0, c1] = sortTokens(getAddress(tokenA), getAddress(tokenB));
  const logs = await client.getLogs({
    address: poolManager,
    event: {
      type: "event", name: "Initialize",
      inputs: [
        { indexed: true, name: "id", type: "bytes32" }, { indexed: true, name: "currency0", type: "address" }, { indexed: true, name: "currency1", type: "address" },
        { indexed: false, name: "fee", type: "uint24" }, { indexed: false, name: "tickSpacing", type: "int24" }, { indexed: false, name: "hooks", type: "address" },
        { indexed: false, name: "sqrtPriceX96", type: "uint160" }, { indexed: false, name: "tick", type: "int24" },
      ],
    },
    args: { currency0: c0, currency1: c1 },
    fromBlock,
    toBlock,
  });
  const keys: PoolKey[] = logs.map((l) => ({ currency0: c0, currency1: c1, fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing), hooks: l.args.hooks as Address }));
  if (keys.length === 0) return keys;
  const liqCalls: Call[] = keys.map((k) => ({ address: UNISWAP_V4_STATE_VIEW, abi: v4StateViewAbi, functionName: "getLiquidity", args: [poolId(k)] }));
  const liq = (await client.multicall({ allowFailure: true, multicallAddress: MULTICALL3, contracts: liqCalls as never })) as MulticallResult[];
  return keys.filter((_, i) => { const r = liq[i]!; return r.status === "success" && (r.result as bigint) > 0n; });
}
