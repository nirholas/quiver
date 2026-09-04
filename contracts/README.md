# Quiver contracts

`src/QuiverSettlement.sol` and its deterministic deploy script. `forge test` runs 11 unit tests plus a fuzz property against the real Permit2 bytecode; `RHC_MAINNET_RPC_URL=... forge test --match-contract Fork` settles a real Uniswap v3 swap on a fork of Robinhood Chain. Details: [docs/contracts.md](../docs/contracts.md) and [docs/protocol.md](../docs/protocol.md).
