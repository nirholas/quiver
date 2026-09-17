import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
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

  it("ranks bids above the signed 64-bit range by value, not by a saturating cast", async () => {
    const { app: a, db } = app();
    const rfqId = openRfq(db);
    // Both amounts cast to the same SQLite INTEGER (9223372036854775807); only the larger decimal may win.
    const low = await bid(a, rfqId, "10000000000000000000");
    expect(low.leading).toBe(true);
    const high = await bid(a, rfqId, "10000000000000000001");
    expect(high.leading).toBe(true);
    const after = await bid(a, rfqId, "9999999999999999999");
    expect(after.leading).toBe(false);

    expect(db.bids(rfqId).map((b) => b.amount_out)).toEqual(["10000000000000000001", "10000000000000000000", "9999999999999999999"]);
    expect(db.getRfq(rfqId)!.best_out).toBe("10000000000000000001");
    expect(db.getRfq(rfqId)!.best_solver).toBe(high.solver);

    const view = (await (await a.request(`/rfq/${rfqId}`)).json()) as { best: { solver: string; amountOut: string } };
    expect(view.best.amountOut).toBe("10000000000000000001");
    expect(view.best.solver).toBe(high.solver);
  });

  it("ranks a uint256-max bid first and rejects amounts that are not canonical uint256", async () => {
    const { app: a, db } = app();
    const rfqId = openRfq(db);
    const max = (2n ** 256n - 1n).toString();
    await bid(a, rfqId, "115792089237316195423570985008687907853269984665640564039457584007913129639934");
    const top = await bid(a, rfqId, max);
    expect(top.leading).toBe(true);
    expect(db.bids(rfqId)[0]!.amount_out).toBe(max);

    for (const bad of [(2n ** 256n).toString(), "0100", "1e18", "-1"]) {
      expect((await postBid(a, rfqId, bad)).res.status).toBe(400);
    }
  });

  it("breaks equal bids by arrival order", async () => {
    const { app: a, db } = app();
    const rfqId = openRfq(db);
    const first = await bid(a, rfqId, "10000000000000000000");
    const second = await bid(a, rfqId, "10000000000000000000");
    expect(second.leading).toBe(false);
    expect(db.getRfq(rfqId)!.best_solver).toBe(first.solver);
  });

  it("marks an order filled when its settlement was observed before the order was submitted", async () => {
    const { app: a, db } = app();
    const seller = privateKeyToAccount(generatePrivateKey());
    const solver = privateKeyToAccount(generatePrivateKey());
    const now = Math.floor(Date.now() / 1000);
    const signed = await signOrder(
      { seller: seller.address, sellToken: WETH, buyToken: USDG, sellAmount: 10n ** 17n, minBuyAmount: 1n, receiver: seller.address, deadline: BigInt(now + 600), exclusiveSolver: ZERO_ADDRESS, exclusiveUntil: 0n, appData: ZERO_BYTES32 },
      settlement,
      (typed) => seller.signTypedData(typed as never),
    );
    db.upsertSolver(solver.address, "early", now);

    // The watcher sees Settled first: nothing to update yet, but the settlement must survive the cursor moving on.
    const settled = { order_hash: signed.orderHash, tx_hash: "0xfeed", solver: solver.address, buy_amount: "10000000000000000001", block: 10, log_index: 0, observed_at: now };
    expect(db.recordSettlement(settled)).toBeUndefined();
    expect(db.stats().unmatchedSettlements).toBe(1);

    const res = await a.request("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(serializeSignedOrder(signed)) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { status: string }).status).toBe("filled");

    const row = db.getOrder(signed.orderHash)!;
    expect(row.status).toBe("filled");
    expect(row.tx_hash).toBe("0xfeed");
    expect(row.buy_amount).toBe("10000000000000000001");
    expect(row.solver).toBe(solver.address.toLowerCase());
    expect(db.openOrders()).toHaveLength(0);
    expect(db.stats().unmatchedSettlements).toBe(0);

    // A replayed log (restart, reorg re-scan) must not fill or count twice.
    expect(db.recordSettlement(settled)).toBeUndefined();
    expect(db.reconcileSettlement(signed.orderHash)).toBeUndefined();
    expect(db.solvers().find((s) => s.address === solver.address.toLowerCase())!.fills).toBe(1);
  });
});

/** An RFQ row open for bidding, inserted directly so the test does not need a live quote. */
function openRfq(db: ApiDb): string {
  const id = `rfq-${Math.random().toString(16).slice(2)}`;
  db.insertRfq({
    id, token_in: WETH.toLowerCase(), token_out: USDG.toLowerCase(), amount_in: "10000000000000000000", seller: "0x1111111111111111111111111111111111111111",
    baseline_out: "1", baseline_venue: null, best_solver: null, best_out: null, created_at: Math.floor(Date.now() / 1000), expires_at: Date.now() + 60_000,
  });
  return id;
}

/** Posts a signed bid from a fresh solver, as the solver client does. */
async function postBid(a: Hono, rfqId: string, amountOut: string): Promise<{ res: Response; solver: string }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const signature = await account.signMessage({ message: `quiver-bid:${rfqId}:${amountOut}` });
  const res = await a.request("/bids", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rfqId, amountOut, solver: account.address, signature }) });
  return { res, solver: account.address.toLowerCase() };
}

/** Posts a bid that is expected to be accepted, and reports who bid and whether they lead. */
async function bid(a: Hono, rfqId: string, amountOut: string): Promise<{ leading: boolean; solver: string }> {
  const { res, solver } = await postBid(a, rfqId, amountOut);
  expect(res.status).toBe(200);
  const { leading } = (await res.json()) as { leading: boolean };
  return { leading, solver };
}
