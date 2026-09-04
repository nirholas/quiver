# Quiver API

`pnpm api`. Configuration: `QUIVER_SETTLEMENT` (required), `QUIVER_RPC_URL`, `QUIVER_API_PORT` (4700), `QUIVER_DB`, `QUIVER_RFQ_WINDOW_MS` (1500), `QUIVER_EXCLUSIVITY_SECONDS` (20), `QUIVER_ORDER_TTL_SECONDS` (180), `QUIVER_V4_LOOKBACK_BLOCKS` (200000), `QUIVER_WATCH_MS` (3000).

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/` | | manifest: `settlement`, `chainId`, auction parameters, `solversConnected` |
| GET | `/tokens` | | curated token list |
| GET | `/quote` | `tokenIn`, `tokenOut`, `amountIn` (atomic) | `amountOut`, `routes[]` (venues, hops, per-route amounts), `bestDirect`, `blockNumber` |
| POST | `/rfq` | `{ tokenIn, tokenOut, amountIn, seller }` | after the window: `baseline`, `bids[]`, `best { solver, amountOut, exclusiveUntil }` |
| GET | `/rfq/:id` | | same view |
| POST | `/bids` | `{ rfqId, amountOut, solver, signature }` | `{ ok, leading }`; 409 once the window closed |
| POST | `/orders` | serialized signed order (+ optional `rfqId`) | 201 with status; 401 if the signature does not recover to `seller`; 400 if `exclusiveSolver` is not the RFQ winner |
| GET | `/orders?seller=` | | recent orders (or a seller's) |
| GET | `/orders/:hash` | | `status` (open, filled, expired, cancelled, failed), `txHash`, `buyAmount`, `solver` |
| GET | `/orders/:hash/signed` | | the full signed payload (for solvers) |
| GET | `/orders/open/all` | | every open signed order |
| POST | `/solvers/register` | `{ address, name, signature }` (`personal_sign("quiver-solver:<name>")`) | `{ ok }` |
| GET | `/solvers` | | leaderboard: bids, fills, last seen |
| GET | `/solvers/stream` | SSE | events `hello`, `rfq`, `order`, `filled`, `ping` |
| GET | `/stats` | | counters |

The watcher polls `Settled` logs on the settlement contract and marks orders filled with the tx hash and delivered amount; orders past their deadline are marked expired.
