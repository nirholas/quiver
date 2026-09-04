import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signOrder, ZERO_ADDRESS, ZERO_BYTES32, serializeSignedOrder } from "@quiverdex/sdk";
import { USDG, WETH } from "@quiverdex/router";
import { ApiDb } from "../src/db.js";
import { Bus } from "../src/bus.js";
import { createApi } from "../src/server.js";

const settlement = "0x4479FBeD8d3a54818D1E155fEe59226825da1E82" as const;
const cfg = { rpcUrl: "http://unused", settlement, port: 0, dbPath: ":memory:", rfqWindowMs: 10, exclusivitySeconds: 20, orderTtlSeconds: 180, v4LookbackBlocks: 10, watchMs: 1000 };
const fakeClient = { getBlockNumber: async () => 1n } as unknown as PublicClient;

function app() {
  const db = new ApiDb(":memory:");
  return { app: createApi({ cfg, db, bus: new Bus(), client: fakeClient }), db };
}

describe("Quiver API", () => {
  it("serves the manifest and token list", async () => {
    const { app: a } = app();
    const m = (await (await a.request("/")).json()) as { settlement: string; chainId: number };
    expect(m.settlement).toBe(settlement);
    expect(m.chainId).toBe(4663);
    const tokens = (await (await a.request("/tokens")).json()) as Array<{ symbol: string }>;
    expect(tokens.map((t) => t.symbol)).toContain("USDG");
  });

  it("rejects malformed quote requests", async () => {
    const { app: a } = app();
    expect((await a.request("/quote?tokenIn=nope")).status).toBe(400);
  });

  it("accepts a correctly signed order and rejects a forged one", async () => {
    const { app: a, db } = app();
    const seller = privateKeyToAccount(generatePrivateKey());
    const now = Math.floor(Date.now() / 1000);
    const signed = await signOrder(
      { seller: seller.address, sellToken: WETH, buyToken: USDG, sellAmount: 10n ** 17n, minBuyAmount: 1n, receiver: seller.address, deadline: BigInt(now + 600), exclusiveSolver: ZERO_ADDRESS, exclusiveUntil: 0n, appData: ZERO_BYTES32 },
      settlement,
      (typed) => seller.signTypedData(typed as never),
    );
    const ok = await a.request("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(serializeSignedOrder(signed)) });
    expect(ok.status).toBe(201);
    expect(db.getOrder(signed.orderHash)?.status).toBe("open");

    const dup = await a.request("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(serializeSignedOrder(signed)) });
    expect(dup.status).toBe(409);

    const forged = serializeSignedOrder({ ...signed, order: { ...signed.order, minBuyAmount: 1n }, orderHash: signed.orderHash });
    forged.order.receiver = "0x1111111111111111111111111111111111111111";
    const bad = await a.request("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forged) });
    expect([400, 401]).toContain(bad.status);

    const list = (await (await a.request(`/orders?seller=${seller.address}`)).json()) as Array<{ orderHash: string }>;
    expect(list[0]!.orderHash).toBe(signed.orderHash.toLowerCase());
  });

  it("rejects bids without a valid signature and unknown rfqs", async () => {
    const { app: a } = app();
    const res = await a.request("/bids", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rfqId: "nope", amountOut: "1", solver: "0x1111111111111111111111111111111111111111", signature: "0x00" }) });
    expect(res.status).toBe(404);
  });
});
