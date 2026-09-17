import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signOrder, ZERO_ADDRESS, ZERO_BYTES32, serializeSignedOrder } from "@quiverdex/sdk";
import { USDG, WETH } from "@quiverdex/router";
import { ApiDb } from "../src/db.js";
import { Bus } from "../src/bus.js";
import { createApi } from "../src/server.js";
import { Watcher } from "../src/watcher.js";

const settlement = "0x4479FBeD8d3a54818D1E155fEe59226825da1E82" as const;
const cfg = { rpcUrl: "http://unused", settlement, port: 0, dbPath: ":memory:", rfqWindowMs: 10, exclusivitySeconds: 20, orderTtlSeconds: 180, v4LookbackBlocks: 10, watchMs: 1000 };

/** A chain that is at `head` and returns the queued Settled logs for any range that covers them. */
function chain(head: number, logs: Array<{ blockNumber: bigint; orderHash: string; solver: string; buyAmount: bigint; txHash: string }>) {
  return {
    getBlockNumber: async () => BigInt(head),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      logs
        .filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
        .map((l, i) => ({ blockNumber: l.blockNumber, logIndex: i, transactionHash: l.txHash, args: { orderHash: l.orderHash, solver: l.solver, buyAmount: l.buyAmount } })),
  } as unknown as PublicClient;
}

async function signedOrder(deadlineSeconds: number) {
  const seller = privateKeyToAccount(generatePrivateKey());
  return signOrder(
    { seller: seller.address, sellToken: WETH, buyToken: USDG, sellAmount: 10n ** 17n, minBuyAmount: 1n, receiver: seller.address, deadline: BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds), exclusiveSolver: ZERO_ADDRESS, exclusiveUntil: 0n, appData: ZERO_BYTES32 },
    settlement,
    (typed) => seller.signTypedData(typed as never),
  );
}

describe("Watcher", () => {
  it("keeps a Settled log that arrives before the order and applies it on submission", async () => {
    const db = new ApiDb(":memory:");
    const bus = new Bus();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));
    const signed = await signedOrder(600);
    const solver = privateKeyToAccount(generatePrivateKey());
    const client = chain(100, [{ blockNumber: 90n, orderHash: signed.orderHash, solver: solver.address, buyAmount: 10n ** 19n + 1n, txHash: "0xabc" }]);

    await new Watcher(cfg, db, bus, client).tick();
    expect(db.cursor("settled")).toBe(100);
    expect(db.stats().unmatchedSettlements).toBe(1);
    expect(events).toEqual([]);

    const app = createApi({ cfg, db, bus, client });
    const res = await app.request("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(serializeSignedOrder(signed)) });
    expect(res.status).toBe(201);
    expect(db.getOrder(signed.orderHash)!.status).toBe("filled");
    expect(db.getOrder(signed.orderHash)!.buy_amount).toBe((10n ** 19n + 1n).toString());
    // Solvers are told the order is filled, never that it is open for filling.
    expect(events).toEqual(["filled"]);

    // The cursor has moved past the log, so a later tick must not change anything.
    await new Watcher(cfg, db, bus, client).tick();
    expect(events).toEqual(["filled"]);
    expect(db.stats().filled).toBe(1);
  });

  it("fills a known order and publishes once, even if the same log is re-scanned", async () => {
    const db = new ApiDb(":memory:");
    const bus = new Bus();
    const filled: string[] = [];
    bus.subscribe((e) => { if (e.type === "filled") filled.push(e.orderHash); });
    const signed = await signedOrder(600);
    const solver = privateKeyToAccount(generatePrivateKey());
    db.upsertSolver(solver.address, "s", Math.floor(Date.now() / 1000));
    db.insertOrder(serializeSignedOrder(signed), null, Math.floor(Date.now() / 1000));
    const client = chain(100, [{ blockNumber: 90n, orderHash: signed.orderHash, solver: solver.address, buyAmount: 5n, txHash: "0xabc" }]);

    await new Watcher(cfg, db, bus, client).tick();
    db.setCursor("settled", 50); // force a re-scan of the same range, as a restart or reorg would
    await new Watcher(cfg, db, bus, client).tick();

    expect(filled).toEqual([signed.orderHash.toLowerCase()]);
    expect(db.solvers().find((s) => s.address === solver.address.toLowerCase())!.fills).toBe(1);
  });

  it("corrects an order it already expired when the fill turns up late", async () => {
    const db = new ApiDb(":memory:");
    const bus = new Bus();
    const filled: string[] = [];
    bus.subscribe((e) => { if (e.type === "filled") filled.push(e.orderHash); });
    const signed = await signedOrder(-60); // deadline already passed: the watcher expires it on the next sweep
    const solver = privateKeyToAccount(generatePrivateKey());
    db.upsertSolver(solver.address, "late", Math.floor(Date.now() / 1000));
    db.insertOrder(serializeSignedOrder(signed), null, Math.floor(Date.now() / 1000));

    await new Watcher(cfg, db, bus, chain(100, [])).tick();
    expect(db.getOrder(signed.orderHash)!.status).toBe("expired");

    // The node was behind, so the fill is only seen now. On-chain truth wins over the local guess.
    const late = chain(140, [{ blockNumber: 120n, orderHash: signed.orderHash, solver: solver.address, buyAmount: 7n, txHash: "0xabc" }]);
    await new Watcher(cfg, db, bus, late).tick();
    expect(db.getOrder(signed.orderHash)!.status).toBe("filled");
    expect(db.getOrder(signed.orderHash)!.buy_amount).toBe("7");
    expect(filled).toEqual([signed.orderHash.toLowerCase()]);
    expect(db.solvers().find((s) => s.address === solver.address.toLowerCase())!.fills).toBe(1);
  });
});
