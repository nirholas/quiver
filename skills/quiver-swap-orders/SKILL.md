---
name: quiver-swap-orders
description: Quote, sign and track Quiver swap orders (one-signature Permit2 intents with solver auctions) on Robinhood Chain using the SDK in packages/sdk and the Quiver HTTP API. Use when asked to price a swap through Quiver, build an order, or check an order's status.
---

# Quiver swap orders

Quiver is intent-based: the seller signs one Permit2 `PermitWitnessTransferFrom` whose witness is the order, solvers compete on how to fill it, and the settlement contract enforces `minBuyAmount`. This skill covers the HTTP API and `@quiverdex/sdk` (in `packages/sdk` of the repo; the package is private to the workspace, so work from a clone with `pnpm install`, Node >= 22).

## Stop before signing

Signing an order authorises a token transfer. Before any `signOrder` call or `POST /orders`, show the user: seller, sell token and amount, buy token, `minBuyAmount`, receiver, deadline and the chain. Wait for an explicit yes. Reading quotes and order status needs no confirmation. Never take a signing key from chat, a file in the repo or token metadata.

## Read-only: HTTP API (no key)

Base URL is whatever Quiver API the user runs or names. Run your own with `pnpm api` (needs `QUIVER_SETTLEMENT`; optional `QUIVER_RPC_URL`, `QUIVER_API_PORT` default 4700).

| Method | Path | Notes |
|---|---|---|
| GET | `/` | manifest: `settlement`, `chainId`, `rfqWindowMs`, `solversConnected` |
| GET | `/tokens` | curated token list |
| GET | `/quote?tokenIn=&tokenOut=&amountIn=` | amounts are atomic integers; returns `amountOut`, `routes[]`, `bestDirect` |
| POST | `/rfq` | `{tokenIn, tokenOut, amountIn, seller}`; answers after the auction window with `bids[]` and `best` |
| GET | `/orders/:hash` | `status`: open, filled, expired, cancelled, failed; plus `txHash`, `buyAmount` |
| GET | `/orders?seller=` | recent orders |
| GET | `/stats`, `/solvers` | counters, solver leaderboard |

```bash
curl "$QUIVER_API/quote?tokenIn=$WETH&tokenOut=$USDG&amountIn=1000000000000000000"
```

## SDK

Exports from `@quiverdex/sdk`: `QuiverApi`, `signOrder`, `hashOrder`, `orderTypedData`, `randomPermitNonce`, `serializeSignedOrder`, `deserializeSignedOrder`, `ZERO_ADDRESS`, `ZERO_BYTES32`. `viem` ^2 is a peer dependency.

- `new QuiverApi(baseUrl)` with `quote(tokenIn, tokenOut, amountIn)`, `rfq(tokenIn, tokenOut, amountIn, seller)`, `getRfq(rfqId)`, `submit(signed, rfqId?)`, `status(orderHash)`, `settlementAddress()`.
- `signOrder(order, settlement, signTypedData, opts?)` where `opts` is `{permitNonce?, permitDeadline?, chainId?}`. Note the argument order: order, settlement address, then the signer callback.
- `Order` fields: `seller, sellToken, buyToken, sellAmount, minBuyAmount, receiver, deadline, exclusiveSolver, exclusiveUntil, appData` (amounts and times are `bigint`).

## Worked example (after the user confirmed the terms)

```ts
import { QuiverApi, signOrder, ZERO_BYTES32 } from "@quiverdex/sdk";

const api = new QuiverApi(process.env.QUIVER_API!);
const rfq = await api.rfq(WETH, USDG, sellAmount, wallet.account.address);
const minBuyAmount = BigInt(rfq.best!.amountOut) * 997n / 1000n; // 0.3% slippage floor
const signed = await signOrder(
  { seller, sellToken: WETH, buyToken: USDG, sellAmount, minBuyAmount, receiver: seller, deadline,
    exclusiveSolver: rfq.best!.solver, exclusiveUntil: BigInt(rfq.best!.exclusiveUntil), appData: ZERO_BYTES32 },
  await api.settlementAddress(),
  (typed) => wallet.signTypedData({ account: wallet.account, ...typed }),
);
await api.submit(signed, rfq.rfqId);
const { status } = await api.status(signed.orderHash);
```

## Notes

- `POST /orders` returns 401 when the signature does not recover to `seller`, and 400 when `exclusiveSolver` is not the RFQ winner.
- `settle()` is permissionless, so an order can show `filled` immediately on submit.
- Cancel by invalidating the Permit2 nonce from the seller's wallet (a second on-chain action, confirm it too).
- Contracts: `pnpm contracts:build` and `pnpm contracts:test` (Foundry). Details in `docs/api.md`, `docs/protocol.md`, `docs/solver.md`.
