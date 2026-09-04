# Quiver protocol

## Roles

- **Seller**: signs an order. Never sends a transaction per trade (one Permit2 approval per token, ever).
- **Solver**: any address. Bids on RFQs, submits `settle()` with a route, pays gas, keeps whatever margin it routes to itself inside the interactions.
- **API**: runs the auction and relays orders. It never holds funds or keys, and it is not trusted for correctness: every guarantee the seller has is enforced by the contract from the signature alone.

## Order

```
Order {
  address seller;          // signer, token owner
  address sellToken;       // ERC-20 on 4663 (WETH for native ETH; the app wraps)
  address buyToken;
  uint256 sellAmount;      // exact; unspent input is refunded
  uint256 minBuyAmount;    // the floor the contract enforces on the buy-token delta
  address receiver;        // where buy tokens go
  uint256 deadline;        // unix seconds; settle() reverts after
  address exclusiveSolver; // 0x0 = anyone may fill
  uint256 exclusiveUntil;  // unix seconds; before this only exclusiveSolver may fill
  bytes32 appData;         // integrator tag, emitted as OrderTagged when non-zero
}
```

## Signature

The seller signs Permit2's `PermitWitnessTransferFrom`:

- domain `{ name: "Permit2", chainId: 4663, verifyingContract: 0x000000000022D473030F116dDEE9F6B43aC78BA3 }`
- `permitted = { token: sellToken, amount: sellAmount }`, `spender = QuiverSettlement`, `nonce = permitNonce` (unordered, random 256-bit is fine), `deadline = permitDeadline`
- `witness = Order` with type string `Order witness)Order(address seller,...,bytes32 appData)TokenPermissions(address token,uint256 amount)`

`@quiverdex/sdk`'s `orderTypedData()` produces exactly this; `signOrder()` wraps it.

## Settlement

`settle(order, permitNonce, permitDeadline, signature, interactions)`:

1. `deadline` not passed; `sellToken != buyToken`; `sellAmount > 0`; if `exclusiveSolver` is set and `now <= exclusiveUntil`, `msg.sender` must be it.
2. Snapshot the contract's sell- and buy-token balances.
3. `Permit2.permitWitnessTransferFrom(...)` pulls `sellAmount` to the contract. A bad signature, a used nonce or a tampered order field reverts here.
4. Execute `interactions` in order from the contract. Any target except Permit2. Any revert bubbles with its index.
5. `received = buyBalance - buyBefore`; revert `LimitNotMet` if `received < minBuyAmount`.
6. Transfer `received * feeBps / 10000` to `feeRecipient` (0 at launch), the rest to `receiver`.
7. Return `sellBalance - sellBefore` (unspent input) to the seller.
8. Emit `Settled(orderHash, seller, solver, sellToken, buyToken, sellSpent, buyAmount, fee)` and, when `appData != 0`, `OrderTagged(orderHash, appData)`.

Properties, all covered by tests: the seller cannot be debited more than `sellAmount` or receive less than `minBuyAmount`; a solver cannot redirect the payout, replay an order, or keep buy tokens from the order it fills; an order can be cancelled by invalidating its Permit2 nonce; exclusivity is enforced only inside its window.

## Auction

`POST /rfq` quotes the pair on-chain (the baseline), broadcasts the RFQ to connected solvers, waits `QUIVER_RFQ_WINDOW_MS` (1500 ms), and returns the bids. Bids are `personal_sign("quiver-bid:<rfqId>:<amountOut>")` by the solver key, so a bid cannot be forged. The best bid's solver becomes `exclusiveSolver` in the order the seller signs, with `exclusiveUntil = now + QUIVER_EXCLUSIVITY_SECONDS` (20). If the winner does not fill inside its window, any solver may. If nobody bids, the app places an unrestricted order at the on-chain quote minus slippage.

The auction is off-chain and the API is not trusted: the seller sees the winning bid, sets `minBuyAmount` from it, and the contract holds the solver to that number.

## Routing

`@quiverdex/router` quotes a pair by discovering the v2 pair and every v3 fee-tier pool in one multicall, then quoting all of them plus any cached v4 pools (discovered from `PoolManager.Initialize` logs and filtered by live liquidity) in a second multicall. It adds two-hop paths through WETH and USDG and tries 25/50/75 splits across the two best direct routes. `buildInteractions()` compiles a route set into one `UniversalRouter.execute` per route: transfer the input to the router, pay every hop from the router's balance, keep intermediates in the router, pay the last hop to `MSG_SENDER` (the settlement contract inside the router). Each route carries a proportional share of the seller's floor as its own `amountOutMinimum`.

Robinhood Chain's UniversalRouter (`0x8876789976DEcbFCBbbE364623c63652DB8C0904`) is a modified build: `V2_SWAP_EXACT_IN` and `V3_SWAP_EXACT_IN` inputs end with `uint256[] minHopPriceX36`, a per-hop minimum-price guard. Standard UniversalRouter encodings revert with `SliceOutOfBounds()` on this chain. Quiver passes an empty array and relies on the settlement contract's final-delta check instead.
