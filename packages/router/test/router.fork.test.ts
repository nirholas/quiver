import { describe, expect, it } from "vitest";
import { createPublicClient, http, type PublicClient } from "viem";
import { quote, quoteSingleHops } from "../src/quote.js";
import { RPC_URL, USDG, WETH, UNISWAP_V4_POOL_MANAGER } from "../src/addresses.js";
import { discoverV4Pools } from "../src/quote.js";

const rpc = process.env.RHC_MAINNET_RPC_URL ?? RPC_URL;
const client = createPublicClient({ transport: http(rpc, { batch: true }) }) as PublicClient;

describe("live quoting on Robinhood Chain", () => {
  it("finds v2 and v3 liquidity for WETH -> USDG and the aggregate is at least the best direct", async () => {
    const singles = await quoteSingleHops(client, WETH, USDG, 10n ** 18n);
    const venues = new Set(singles.map((r) => r.hops[0]!.venue));
    expect(venues.has("uniswap-v3")).toBe(true);
    expect(venues.has("uniswap-v2")).toBe(true);
    // ~2,500 USDG per WETH at time of writing; assert a sane band rather than a price.
    expect(singles[0]!.amountOut).toBeGreaterThan(500n * 10n ** 6n);
    const q = await quote(client, WETH, USDG, 10n ** 18n, { directOnly: true });
    // Same call, same block: the aggregate can never be worse than the best single venue it saw.
    expect(q.amountOut).toBeGreaterThanOrEqual(q.bestDirect!.amountOut);
    expect(q.routes.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("discovers v4 pools from Initialize logs when asked", async () => {
    const head = await client.getBlockNumber();
    const keys = await discoverV4Pools(client, UNISWAP_V4_POOL_MANAGER, WETH, USDG, head - 40_000n, head);
    expect(Array.isArray(keys)).toBe(true);
  }, 120_000);
});
