import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getAddress, isAddress, recoverMessageAddress, recoverTypedDataAddress, type Address, type PublicClient } from "viem";
import { randomBytes } from "node:crypto";
import { CHAIN_ID, TOKENS, UNISWAP_V4_POOL_MANAGER, discoverV4Pools, quote, type PoolKey } from "@quiverdex/router";
import { deserializeSignedOrder, hashOrder, orderTypedData, type SerializedSignedOrder } from "@quiverdex/sdk";
import type { ApiConfig } from "./config.js";
import type { ApiDb } from "./db.js";
import type { Bus } from "./bus.js";

export const VERSION = "0.1.0";

export type ServerDeps = { cfg: ApiConfig; db: ApiDb; bus: Bus; client: PublicClient; startedAt?: number };

const ZERO = "0x0000000000000000000000000000000000000000";

export function createApi({ cfg, db, bus, client, startedAt = Date.now() }: ServerDeps): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));
  const now = () => Math.floor(Date.now() / 1000);
  const pairKey = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join(":");

  /** v4 pools for a pair: cached in SQLite, refreshed from Initialize logs when the cache is behind the head. */
  async function v4PoolsFor(tokenIn: Address, tokenOut: Address): Promise<PoolKey[]> {
    const key = pairKey(tokenIn, tokenOut);
    const head = Number(await client.getBlockNumber());
    const scannedTo = db.v4ScannedTo(key);
    if (scannedTo === undefined || head - scannedTo > 5_000) {
      const from = BigInt(scannedTo === undefined ? Math.max(head - cfg.v4LookbackBlocks, 0) : scannedTo + 1);
      try {
        const keys = await discoverV4Pools(client, UNISWAP_V4_POOL_MANAGER, tokenIn, tokenOut, from, BigInt(head));
        db.saveV4Pools(key, keys, head);
      } catch {
        // rate limited: fall back to whatever is cached
      }
    }
    return db.v4Pools(key).map((r) => ({ currency0: getAddress(r.currency0), currency1: getAddress(r.currency1), fee: r.fee, tickSpacing: r.tick_spacing, hooks: getAddress(r.hooks) }));
  }

  app.get("/", (c) =>
    c.json({
      name: "Quiver API", version: VERSION, chainId: CHAIN_ID, settlement: cfg.settlement,
      rfqWindowMs: cfg.rfqWindowMs, exclusivitySeconds: cfg.exclusivitySeconds, orderTtlSeconds: cfg.orderTtlSeconds,
      solversConnected: bus.size, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      endpoints: ["/tokens", "/quote", "/rfq", "/rfq/:id", "/bids", "/orders", "/orders/:hash", "/solvers", "/solvers/register", "/solvers/stream", "/stats"],
    }),
  );

  app.get("/tokens", (c) => c.json(TOKENS));
  app.get("/stats", (c) => c.json(db.stats()));
  app.get("/solvers", (c) => c.json(db.solvers()));

  app.get("/quote", async (c) => {
    const tokenIn = c.req.query("tokenIn"), tokenOut = c.req.query("tokenOut"), amountIn = c.req.query("amountIn");
    if (!tokenIn || !tokenOut || !amountIn || !isAddress(tokenIn) || !isAddress(tokenOut) || !/^\d+$/.test(amountIn)) {
      return c.json({ error: "tokenIn, tokenOut (addresses) and amountIn (atomic integer) are required" }, 400);
    }
    const v4Pools = await v4PoolsFor(getAddress(tokenIn), getAddress(tokenOut));
    const q = await quote(client, getAddress(tokenIn), getAddress(tokenOut), BigInt(amountIn), { v4Pools });
    return c.json(serializeQuote(q));
  });

  app.post("/rfq", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { tokenIn?: string; tokenOut?: string; amountIn?: string; seller?: string } | null;
    if (!body?.tokenIn || !body.tokenOut || !body.amountIn || !body.seller || !isAddress(body.tokenIn) || !isAddress(body.tokenOut) || !isAddress(body.seller) || !/^\d+$/.test(body.amountIn)) {
      return c.json({ error: "tokenIn, tokenOut, amountIn, seller are required" }, 400);
    }
    const tokenIn = getAddress(body.tokenIn), tokenOut = getAddress(body.tokenOut);
    const v4Pools = await v4PoolsFor(tokenIn, tokenOut);
    const baseline = await quote(client, tokenIn, tokenOut, BigInt(body.amountIn), { v4Pools });
    const id = randomBytes(12).toString("hex");
    const createdAt = now();
    const expiresAt = Date.now() + cfg.rfqWindowMs;
    db.insertRfq({ id, token_in: tokenIn.toLowerCase(), token_out: tokenOut.toLowerCase(), amount_in: body.amountIn, seller: body.seller.toLowerCase(), baseline_out: baseline.amountOut.toString(), baseline_venue: baseline.bestDirect?.venue ?? null, best_solver: null, best_out: null, created_at: createdAt, expires_at: expiresAt });
    bus.publish({ type: "rfq", rfq: { rfqId: id, tokenIn, tokenOut, amountIn: body.amountIn, seller: body.seller, expiresAt, baselineOut: baseline.amountOut.toString() } });
    // Hold the request open for the bidding window, then answer with the best bid.
    await new Promise((r) => setTimeout(r, cfg.rfqWindowMs));
    return c.json(rfqView(id));
  });

  app.get("/rfq/:id", (c) => {
    const view = rfqView(c.req.param("id"));
    return view ? c.json(view) : c.json({ error: "unknown rfq" }, 404);
  });

  /** Solver bid: { rfqId, amountOut, solver, signature } where signature = personal_sign(`quiver-bid:${rfqId}:${amountOut}`). */
  app.post("/bids", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { rfqId?: string; amountOut?: string; solver?: string; signature?: `0x${string}` } | null;
    if (!body?.rfqId || !body.amountOut || !body.solver || !body.signature || !isAddress(body.solver) || !/^\d+$/.test(body.amountOut)) {
      return c.json({ error: "rfqId, amountOut, solver, signature are required" }, 400);
    }
    const rfq = db.getRfq(body.rfqId);
    if (!rfq) return c.json({ error: "unknown rfq" }, 404);
    if (Date.now() > rfq.expires_at) return c.json({ error: "bidding closed" }, 409);
    const recovered = await recoverMessageAddress({ message: `quiver-bid:${body.rfqId}:${body.amountOut}`, signature: body.signature }).catch(() => null);
    if (!recovered || recovered.toLowerCase() !== body.solver.toLowerCase()) return c.json({ error: "bad bid signature" }, 401);
    const solverAddr = body.solver.toLowerCase();
    db.upsertSolver(solverAddr, db.solvers().find((s) => s.address === solverAddr)?.name ?? "unnamed", now());
    db.upsertBid({ rfq_id: body.rfqId, solver: body.solver, amount_out: body.amountOut, received_at: Date.now() });
    const best = db.bids(body.rfqId)[0]!;
    db.setRfqBest(body.rfqId, best.solver, best.amount_out);
    return c.json({ ok: true, leading: best.solver === body.solver.toLowerCase() });
  });

  app.post("/orders", async (c) => {
    const body = (await c.req.json().catch(() => null)) as (SerializedSignedOrder & { rfqId?: string }) | null;
    if (!body?.order || !body.signature) return c.json({ error: "signed order required" }, 400);
    let signed;
    try {
      signed = deserializeSignedOrder(body);
    } catch {
      return c.json({ error: "malformed order" }, 400);
    }
    const o = signed.order;
    if (signed.chainId !== CHAIN_ID) return c.json({ error: `wrong chainId, expected ${CHAIN_ID}` }, 400);
    if (signed.settlement.toLowerCase() !== cfg.settlement.toLowerCase()) return c.json({ error: `wrong settlement, expected ${cfg.settlement}` }, 400);
    if (o.deadline <= BigInt(now())) return c.json({ error: "order already expired" }, 400);
    if (o.sellAmount <= 0n || o.minBuyAmount <= 0n) return c.json({ error: "amounts must be positive" }, 400);
    const expectedHash = hashOrder(o);
    if (expectedHash.toLowerCase() !== signed.orderHash.toLowerCase()) return c.json({ error: "orderHash mismatch" }, 400);
    const typed = orderTypedData(o, cfg.settlement, signed.permitNonce, signed.permitDeadline, CHAIN_ID);
    const recovered = await recoverTypedDataAddress({ ...typed, signature: signed.signature }).catch(() => null);
    if (!recovered || recovered.toLowerCase() !== o.seller.toLowerCase()) return c.json({ error: "signature does not recover to seller" }, 401);
    if (body.rfqId) {
      const rfq = db.getRfq(body.rfqId);
      if (!rfq) return c.json({ error: "unknown rfq" }, 404);
      if (rfq.best_solver && o.exclusiveSolver.toLowerCase() !== rfq.best_solver) return c.json({ error: `exclusiveSolver must be the RFQ winner ${rfq.best_solver}` }, 400);
    }
    if (db.getOrder(signed.orderHash)) return c.json({ error: "duplicate order" }, 409);
    db.insertOrder(body, body.rfqId ?? null, now());
    bus.publish({ type: "order", order: body });
    return c.json(orderView(db.getOrder(signed.orderHash)!), 201);
  });

  app.get("/orders", (c) => {
    const seller = c.req.query("seller");
    const rows = seller && isAddress(seller) ? db.ordersBySeller(seller) : db.recentOrders();
    return c.json(rows.map(orderView));
  });
  app.get("/orders/:hash", (c) => {
    const row = db.getOrder(c.req.param("hash"));
    return row ? c.json(orderView(row)) : c.json({ error: "unknown order" }, 404);
  });
  /** Full signed payload for solvers. */
  app.get("/orders/:hash/signed", (c) => {
    const row = db.getOrder(c.req.param("hash"));
    return row ? c.json(JSON.parse(row.json)) : c.json({ error: "unknown order" }, 404);
  });
  app.get("/orders/open/all", (c) => c.json(db.openOrders().map((r) => JSON.parse(r.json))));

  /** Solver registration: { address, name, signature } with signature = personal_sign(`quiver-solver:${name}`). */
  app.post("/solvers/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { address?: string; name?: string; signature?: `0x${string}` } | null;
    if (!body?.address || !body.name || !body.signature || !isAddress(body.address)) return c.json({ error: "address, name, signature required" }, 400);
    const recovered = await recoverMessageAddress({ message: `quiver-solver:${body.name}`, signature: body.signature }).catch(() => null);
    if (!recovered || recovered.toLowerCase() !== body.address.toLowerCase()) return c.json({ error: "bad signature" }, 401);
    db.upsertSolver(body.address, body.name.slice(0, 64), now());
    return c.json({ ok: true });
  });

  app.get("/solvers/stream", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = bus.subscribe((e) => { void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }); });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ settlement: cfg.settlement, chainId: CHAIN_ID, exclusivitySeconds: cfg.exclusivitySeconds }) });
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 15_000);
      stream.onAbort(() => { clearInterval(ping); unsubscribe(); });
      await new Promise<void>(() => {});
    }),
  );

  function rfqView(id: string) {
    const rfq = db.getRfq(id);
    if (!rfq) return null;
    const bids = db.bids(id);
    const best = bids[0];
    return {
      rfqId: rfq.id, tokenIn: rfq.token_in, tokenOut: rfq.token_out, amountIn: rfq.amount_in, seller: rfq.seller,
      baseline: { amountOut: rfq.baseline_out, venue: rfq.baseline_venue ?? undefined },
      best: best ? { solver: best.solver, amountOut: best.amount_out, exclusiveUntil: String(now() + cfg.exclusivitySeconds) } : undefined,
      bids: bids.map((b) => ({ solver: b.solver, amountOut: b.amount_out, receivedAt: b.received_at })),
      expiresAt: rfq.expires_at,
    };
  }

  return app;
}

function orderView(r: { order_hash: string; status: string; tx_hash: string | null; buy_amount: string | null; solver: string | null; created_at: number; updated_at: number; fail_reason: string | null }) {
  return { orderHash: r.order_hash, status: r.status, txHash: r.tx_hash ?? undefined, buyAmount: r.buy_amount ?? undefined, solver: r.solver ?? undefined, failReason: r.fail_reason ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at };
}

function serializeQuote(q: Awaited<ReturnType<typeof quote>>) {
  return {
    tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn.toString(), amountOut: q.amountOut.toString(),
    routes: q.routes.map((r) => ({ venues: r.hops.map((h) => (h.venue === "uniswap-v3" ? `${h.venue}/${h.fee}` : h.venue)), amountIn: r.amountIn.toString(), amountOut: r.amountOut.toString(), hops: r.hops })),
    bestDirect: q.bestDirect ? { venue: q.bestDirect.venue, amountOut: q.bestDirect.amountOut.toString() } : undefined,
    blockNumber: q.blockNumber.toString(), quotedAt: q.quotedAt,
  };
}

export { ZERO };
