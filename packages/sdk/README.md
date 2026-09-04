# @quiverdex/sdk

Sign and submit Quiver orders.

```ts
import { signOrder, QuiverApi, ZERO_ADDRESS, ZERO_BYTES32 } from "@quiverdex/sdk";

const api = new QuiverApi("https://api.quiver.dev");
const rfq = await api.rfq(WETH, USDG, sellAmount, wallet.account.address);          // 1.5 s solver auction
const minBuy = BigInt(rfq.best!.amountOut) * 997n / 1000n;
const signed = await signOrder(
  { seller, sellToken: WETH, buyToken: USDG, sellAmount, minBuyAmount: minBuy, receiver: seller, deadline, exclusiveSolver: rfq.best!.solver, exclusiveUntil: BigInt(rfq.best!.exclusiveUntil), appData: ZERO_BYTES32 },
  await api.settlementAddress(),
  (typed) => wallet.signTypedData({ account: wallet.account, ...typed }),
);
await api.submit(signed, rfq.rfqId);
const status = await api.status(signed.orderHash);   // open | filled | expired | cancelled | failed
```

One signature: a Permit2 `PermitWitnessTransferFrom` with the order as witness. `hashOrder()` is byte-identical to `QuiverSettlement.hashOrder`. Cancel by invalidating the Permit2 nonce from the seller's wallet.
