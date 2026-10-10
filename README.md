# Quiver 

<!-- three.ws:badges -->
[![GitHub stars](https://img.shields.io/github/stars/nirholas/quiver?style=flat&logo=github)](https://github.com/nirholas/quiver/stargazers) [![Last commit](https://img.shields.io/github/last-commit/nirholas/quiver?style=flat)](https://github.com/nirholas/quiver/commits) [![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat)](https://github.com/nirholas/quiver/pulls) [![AI agent friendly](https://img.shields.io/badge/AI%20agents-AGENTS.md%20%2B%20llms.txt-6d5dfc?style=flat)](https://github.com/nirholas/quiver/blob/HEAD/AGENTS.md)
<!-- /three.ws:badges -->


**Intent-based swap aggregation for Robinhood Chain (`eip155:4663`).** Users sign what they want, solvers compete on how, and `QuiverSettlement` enforces the seller's minimum on-chain. Routes span Uniswap v2, v3 and v4 (the three venues with real liquidity on the chain), and a swap is one signature: a Permit2 witness transfer whose witness is the order.

There was no aggregator on Robinhood Chain before this. Every bot and vault hardcoded a single Uniswap pool. Quiver is the routing layer the rest of the register (vaults, keepers, index rebalancers) can build on.

## What is in the box

| Package | What |
|---|---|
| [`contracts`](contracts) | `QuiverSettlement.sol`: Permit2-funded intent settlement with solver exclusivity, limit enforcement on the buy-token delta, unspent-input refunds, an optional capped protocol fee, no admin. Foundry tests against the real Permit2 bytecode plus a live-fork test through Uniswap v3. Deterministic CREATE2 deploy. |
| [`packages/router`](packages/router) (`@quiverdex/router`) | Verified address book for 4663; on-chain quoting across every v2 pair, v3 fee tier and v4 pool for a pair in one multicall; two-hop routes through WETH/USDG; split routing; v4 pool discovery from `Initialize` logs; and `buildInteractions()`, which compiles a route set into UniversalRouter calls the settlement contract executes. |
| [`packages/sdk`](packages/sdk) (`@quiverdex/sdk`) | Order typed data, `signOrder()`, `hashOrder()` (byte-identical to the contract), serialization, and a client for the API. |
| [`apps/api`](apps/api) | Quotes, RFQ auctions with signed solver bids, order intake with signature recovery, an SSE stream for solvers, a `Settled`-log watcher, SQLite. |
| [`apps/solver`](apps/solver) | The reference solver: bids from the on-chain quote minus a margin, simulates, settles. Beatable by design. |
| [`apps/web`](apps/web) | Landing page and the swap app (wallet connect, aggregate quote, auction, one-signature order, fill tracking). Static. |
| [`docs`](docs) | Protocol, API, solver and contract documentation. |

## Quickstart

```bash
git clone https://github.com/nirholas/quiver && cd quiver
pnpm install && pnpm -r build
pnpm test                                   # router, sdk, api, solver unit tests
pnpm contracts:test                         # forge: 11 unit tests + fuzz
RHC_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com pnpm --filter @quiverdex/router test -- test/router.fork.test.ts   # live quoting
pnpm --filter @quiverdex/api e2e            # anvil fork: deploy, quote, auction, sign, submit, solver fill
```

Run it for real:

```bash
cp .env.example .env                        # DEPLOYER_PRIVATE_KEY, SOLVER_PRIVATE_KEY (need ETH on 4663)
(cd contracts && forge script script/DeploySettlement.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast)
QUIVER_SETTLEMENT=0x... pnpm api            # http://localhost:4700
pnpm solver                                 # bids and fills
pnpm web                                    # http://localhost:4701/app.html
```

## Protocol in one paragraph

`Order { seller, sellToken, buyToken, sellAmount, minBuyAmount, receiver, deadline, exclusiveSolver, exclusiveUntil, appData }`. The seller signs a Permit2 `PermitWitnessTransferFrom` with `spender = QuiverSettlement` and `witness = hashOrder(order)`. A solver calls `settle(order, permitNonce, permitDeadline, signature, interactions)`. The contract checks the deadline and exclusivity, pulls `sellAmount` through Permit2, executes the interactions from its own address (Permit2 is never a valid target), requires the buy-token balance delta to be at least `minBuyAmount`, pays the receiver (minus `feeBps`, 0 at launch, capped at 30), and returns any unspent sell tokens to the seller. Cancelling is `Permit2.invalidateUnorderedNonces` from the seller's wallet. Full text in [docs/protocol.md](docs/protocol.md).

## Addresses (Robinhood Chain mainnet, verified on-chain)

| | |
|---|---|
| QuiverSettlement | deterministic; printed by `DeploySettlement.s.sol` (same on 4663 and 46630) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Uniswap v2 factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` |
| Uniswap v3 factory / QuoterV2 / SwapRouter02 | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` / `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` / `0xCaf681a66D020601342297493863E78C959E5cb2` |
| UniversalRouter | `0x8876789976DEcbFCBbbE364623c63652DB8C0904` |
| Uniswap v4 PoolManager / V4Quoter / StateView | `0x8366A39cC670b4001a1121b8F6A443A643E40951` / `0x8dC178Efb8111Bb0973dD9d722EbEff267c98F94` / `0xf3334192d15450cDD385C8b70e03f9a6Bd9E673b` |
| WETH / USDG | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` / `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

## Thanks

[@chenshj73](https://github.com/chenshj73) found and reported both of the correctness bugs fixed in the RFQ and settlement paths: uint256 bid amounts being ranked through a saturating 64-bit cast ([#1](https://github.com/nirholas/quiver/issues/1)), and `Settled` logs being dropped when they arrive before the order reaches the API ([#2](https://github.com/nirholas/quiver/issues/2)). Both reports traced the failure from the contract through the API to the effect on solvers, which is what made them quick to confirm and fix. Thank you.

## License

Apache-2.0. Not affiliated with Robinhood Markets or Uniswap Labs.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=nirholas/quiver&type=Date)](https://www.star-history.com/#nirholas/quiver&Date)

<!-- three.ws:growth -->
## Support the project

If quiver saves you time, **[star it on GitHub](https://github.com/nirholas/quiver)**. Stars are how other developers and AI agents find the repositories worth trusting, and they cost you one click.

Know someone who would use it? [Post on X](https://twitter.com/intent/tweet?text=quiver%3A%20Intent-based%20swap%20aggregation%20for%20Robinhood%20Chain%3A%20one-signature%20Permit2%20orders%2C%20solver%20auctions&url=https%3A%2F%2Fgithub.com%2Fnirholas%2Fquiver) · [Share on Bluesky](https://bsky.app/intent/compose?text=quiver%3A%20Intent-based%20swap%20aggregation%20for%20Robinhood%20Chain%3A%20one-signature%20Permit2%20orders%2C%20solver%20auctions%20https%3A%2F%2Fgithub.com%2Fnirholas%2Fquiver) · [Share on LinkedIn](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fgithub.com%2Fnirholas%2Fquiver) · [Submit to Hacker News](https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fgithub.com%2Fnirholas%2Fquiver&t=quiver%3A%20Intent-based%20swap%20aggregation%20for%20Robinhood%20Chain%3A%20one-signature%20Permit2%20orders%2C%20solver%20auctions) · [Share on Reddit](https://www.reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fnirholas%2Fquiver&title=quiver%3A%20Intent-based%20swap%20aggregation%20for%20Robinhood%20Chain%3A%20one-signature%20Permit2%20orders%2C%20solver%20auctions)

## Built for AI agents too

Coding agents and LLM tooling can read this repo directly: [AGENTS.md](./AGENTS.md), [llms.txt](./llms.txt), [llms-full.txt](./llms-full.txt). Point an agent at `https://github.com/nirholas/quiver` and it has the context it needs.

## More from the same author

- [All repositories by nirholas](https://github.com/nirholas/nirholas#readme): the full catalog, grouped by topic
- [three.ws](https://three.ws): the platform for 3D AI agents with Solana wallets, a skill marketplace and x402 payments
- Questions or ideas: [open an issue](https://github.com/nirholas/quiver/issues) or [start a discussion](https://github.com/nirholas/quiver/discussions)

## Contributors

[![Contributors](https://contrib.rocks/image?repo=nirholas/quiver)](https://github.com/nirholas/quiver/graphs/contributors)

<!-- /three.ws:growth -->
