# @quiverdex/router

On-chain quoting and route search for Robinhood Chain (`eip155:4663`), and the compiler that turns a route into the calls `QuiverSettlement` executes.

```ts
import { createPublicClient, http } from "viem";
import { quote, buildInteractions, discoverV4Pools, WETH, USDG, UNISWAP_V4_POOL_MANAGER } from "@quiverdex/router";

const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
const head = await client.getBlockNumber();
const v4Pools = await discoverV4Pools(client, UNISWAP_V4_POOL_MANAGER, WETH, USDG, head - 200_000n, head);
const q = await quote(client, WETH, USDG, 10n ** 18n, { v4Pools });
// q.amountOut, q.routes (one or two), q.bestDirect
const interactions = buildInteractions(q.routes, q.amountOut * 995n / 1000n, BigInt(Math.floor(Date.now() / 1000) + 120));
```

- `quote()`: v2 pair + every v3 fee tier discovered in one multicall, all quoted (v3 via QuoterV2, v4 via V4Quoter, v2 via exact integer math on reserves) in a second multicall; two-hop paths through WETH and USDG; 25/50/75 splits across the two best direct routes.
- `buildInteractions()`: one `UniversalRouter.execute` per route. **Robinhood Chain's UniversalRouter is a modified build**: v2/v3 swap inputs carry a sixth `uint256[] minHopPriceX36` argument. Standard encodings revert with `SliceOutOfBounds()`; this package encodes the extra argument (empty, since the settlement contract enforces the seller's floor on the final delta).
- `addresses.ts`: every address was read from the chain on 2026-09-03 and is checksummed.

Tests: `pnpm test` (unit) and `RHC_MAINNET_RPC_URL=... pnpm vitest run test/router.fork.test.ts` (live quoting).
