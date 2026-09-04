# Running a Quiver solver

```bash
SOLVER_PRIVATE_KEY=0x...            # needs ETH on 4663 for gas
QUIVER_API_URL=http://localhost:4700
QUIVER_RPC_URL=https://...          # a provider URL; the public RPC rate-limits multicalls under load
SOLVER_NAME=my-solver
SOLVER_MARGIN_BPS=5                 # bid = on-chain quote minus this
SOLVER_MAX_GAS_WEI=2000000000000000 # skip fills whose gas would exceed this
pnpm solver
```

Lifecycle: register (signed name) → sweep open orders → subscribe to `/solvers/stream`. On `rfq`: quote with `@quiverdex/router`, bid `quote * (1 - margin)`, signed. On `order`: skip if another solver holds exclusivity, re-quote, require `quote >= minBuyAmount * (1 + margin)`, `buildInteractions()`, `simulateContract(settle)`, estimate gas, send, wait for the receipt. Every 30 s it re-sweeps open orders, which is how it picks up orders whose winner lapsed.

To beat it: better quotes (more venues, private inventory), tighter margins, faster submission. The contract does not care how you fill, only that the seller's floor is met.
