import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { v2AmountOut, v2ImpactBps } from "../src/v2.js";
import { buildInteractions } from "../src/interactions.js";
import { poolId } from "../src/quote.js";
import { universalRouterAbi, erc20Abi } from "../src/abis.js";
import { UNISWAP_UNIVERSAL_ROUTER, USDG, WETH } from "../src/addresses.js";

describe("v2 math", () => {
  it("matches the pair's integer formula", () => {
    // Real WETH/USDG reserves read on 2026-09-03: 233.546 WETH vs 586,006.909 USDG.
    const rIn = 233546581755660751798n, rOut = 586006909248n;
    const out = v2AmountOut(10n ** 18n, rIn, rOut);
    expect(out).toBeGreaterThan(2_480_000_000n);
    expect(out).toBeLessThan(2_500_000_000n);
    expect(v2ImpactBps(10n ** 18n, rIn, rOut)).toBeGreaterThan(30);
    expect(v2ImpactBps(10n ** 18n, rIn, rOut)).toBeLessThan(80);
    expect(v2AmountOut(0n, rIn, rOut)).toBe(0n);
  });
});

describe("poolId", () => {
  it("hashes the sorted pool key like PoolManager", () => {
    const id = poolId({ currency0: "0x0dbc9d99033b3615c27b3b70432524930f7c1e18", currency1: "0xa90cbab7169698c351a1fb933bcfd8c764351e18", fee: 8388608, tickSpacing: 8, hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544" });
    expect(id.startsWith("0x55f83980ed9c6359")).toBe(true); // observed Initialize log id prefix on 4663
  });
});

describe("buildInteractions", () => {
  it("compiles a split v3+v2 route into two transfer+execute pairs with proportional minimums", () => {
    const routes = [
      { hops: [{ venue: "uniswap-v3" as const, pool: "0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a" as const, fee: 500, tokenIn: WETH, tokenOut: USDG }], amountIn: 5n * 10n ** 17n, amountOut: 1_250_000_000n, gasEstimate: 1n },
      { hops: [{ venue: "uniswap-v2" as const, pool: "0x8803c117ccae7B5146297876c2A25DF135141C4d" as const, tokenIn: WETH, tokenOut: USDG }], amountIn: 5n * 10n ** 17n, amountOut: 1_240_000_000n, gasEstimate: 1n },
    ];
    const ix = buildInteractions(routes, 2_465_100_000n, 1_800_000_000n);
    expect(ix).toHaveLength(4);
    const t0 = decodeFunctionData({ abi: erc20Abi, data: ix[0]!.data });
    expect(t0.functionName).toBe("transfer");
    expect(t0.args).toEqual([UNISWAP_UNIVERSAL_ROUTER, 5n * 10n ** 17n]);
    expect(ix[1]!.target).toBe(UNISWAP_UNIVERSAL_ROUTER);
    const e1 = decodeFunctionData({ abi: universalRouterAbi, data: ix[1]!.data });
    expect(e1.functionName).toBe("execute");
    expect((e1.args as [string, string[], bigint])[0]).toBe("0x00"); // V3_SWAP_EXACT_IN
    const e3 = decodeFunctionData({ abi: universalRouterAbi, data: ix[3]!.data });
    expect((e3.args as [string, string[], bigint])[0]).toBe("0x08"); // V2_SWAP_EXACT_IN
  });

  it("threads a two-hop route through the router balance", () => {
    const routes = [{
      hops: [
        { venue: "uniswap-v3" as const, pool: "0x00" as `0x${string}`, fee: 500, tokenIn: "0x8f86a15EC17cb3369d8b3E666dAdBC11daA82b79" as const, tokenOut: WETH },
        { venue: "uniswap-v2" as const, pool: "0x00" as `0x${string}`, tokenIn: WETH, tokenOut: USDG },
      ],
      amountIn: 10n ** 18n, amountOut: 1000n, gasEstimate: 1n,
    }];
    const ix = buildInteractions(routes, 990n, 1n);
    expect(ix).toHaveLength(2);
    const e = decodeFunctionData({ abi: universalRouterAbi, data: ix[1]!.data });
    expect((e.args as [string, string[], bigint])[0]).toBe("0x0008");
  });
});
