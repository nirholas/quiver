# Contracts

```bash
cd contracts
forge build
forge test -vv                                                                          # 11 unit tests + fuzz, real Permit2 bytecode etched
RHC_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract Fork -vv   # real Uniswap v3 fill on a fork
DEPLOYER_PRIVATE_KEY=0x... forge script script/DeploySettlement.s.sol --rpc-url <rpc> --broadcast
```

`QuiverSettlement(permit2, feeBps, feeRecipient)`: `feeBps <= 30`; a non-zero fee needs a recipient. Compiled with via-IR, `cbor_metadata = false`, `bytecode_hash = "none"` so the CREATE2 address is reproducible. `script/DeploySettlement.s.sol` uses the Arachnid deployer with salt `keccak256("quiver.settlement.v1")`, skips if already deployed, and prints the address.

Dependencies (git submodules): forge-std v1.16.2, OpenZeppelin v5.7.0, Uniswap Permit2 (interfaces only; the runtime bytecode used in tests is captured from Robinhood Chain in `test/deps/Permit2.runtime.hex`).

See [protocol.md](protocol.md) for the settlement semantics and invariants.
