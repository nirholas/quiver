import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SerializedSignedOrder } from "@quiverdex/sdk";

export type RfqRow = {
  id: string; token_in: string; token_out: string; amount_in: string; seller: string;
  baseline_out: string; baseline_venue: string | null; best_solver: string | null; best_out: string | null;
  created_at: number; expires_at: number;
};
export type BidRow = { rfq_id: string; solver: string; amount_out: string; received_at: number };
export type OrderRow = {
  order_hash: string; seller: string; sell_token: string; buy_token: string; sell_amount: string; min_buy_amount: string;
  exclusive_solver: string | null; exclusive_until: number; deadline: number; rfq_id: string | null; json: string;
  status: "open" | "filled" | "expired" | "cancelled" | "failed"; tx_hash: string | null; buy_amount: string | null; solver: string | null;
  fail_reason: string | null; created_at: number; updated_at: number;
};
export type SolverRow = { address: string; name: string; registered_at: number; last_seen: number; bids: number; fills: number };

export class ApiDb {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rfqs (
        id TEXT PRIMARY KEY, token_in TEXT NOT NULL, token_out TEXT NOT NULL, amount_in TEXT NOT NULL, seller TEXT NOT NULL,
        baseline_out TEXT NOT NULL, baseline_venue TEXT, best_solver TEXT, best_out TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bids (
        rfq_id TEXT NOT NULL, solver TEXT NOT NULL, amount_out TEXT NOT NULL, received_at INTEGER NOT NULL,
        PRIMARY KEY (rfq_id, solver)
      );
      CREATE TABLE IF NOT EXISTS orders (
        order_hash TEXT PRIMARY KEY, seller TEXT NOT NULL, sell_token TEXT NOT NULL, buy_token TEXT NOT NULL,
        sell_amount TEXT NOT NULL, min_buy_amount TEXT NOT NULL, exclusive_solver TEXT, exclusive_until INTEGER NOT NULL,
        deadline INTEGER NOT NULL, rfq_id TEXT, json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        tx_hash TEXT, buy_amount TEXT, solver TEXT, fail_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orders_status ON orders(status, deadline);
      CREATE INDEX IF NOT EXISTS orders_seller ON orders(seller, created_at DESC);
      CREATE TABLE IF NOT EXISTS solvers (
        address TEXT PRIMARY KEY, name TEXT NOT NULL, registered_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        bids INTEGER NOT NULL DEFAULT 0, fills INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS v4_pools (
        pair TEXT NOT NULL, currency0 TEXT NOT NULL, currency1 TEXT NOT NULL, fee INTEGER NOT NULL, tick_spacing INTEGER NOT NULL, hooks TEXT NOT NULL,
        scanned_to INTEGER NOT NULL, PRIMARY KEY (pair, fee, tick_spacing, hooks)
      );
      CREATE TABLE IF NOT EXISTS watch_cursor (k TEXT PRIMARY KEY, block INTEGER NOT NULL);
    `);
  }

  insertRfq(r: RfqRow): void {
    this.db.prepare(`INSERT INTO rfqs (id, token_in, token_out, amount_in, seller, baseline_out, baseline_venue, created_at, expires_at) VALUES (@id, @token_in, @token_out, @amount_in, @seller, @baseline_out, @baseline_venue, @created_at, @expires_at)`).run(r);
  }
  getRfq(id: string): RfqRow | undefined {
    return this.db.prepare(`SELECT * FROM rfqs WHERE id = ?`).get(id) as RfqRow | undefined;
  }
  setRfqBest(id: string, solver: string, out: string): void {
    this.db.prepare(`UPDATE rfqs SET best_solver = ?, best_out = ? WHERE id = ?`).run(solver.toLowerCase(), out, id);
  }
  upsertBid(b: BidRow): void {
    this.db.prepare(`INSERT INTO bids (rfq_id, solver, amount_out, received_at) VALUES (@rfq_id, @solver, @amount_out, @received_at)
      ON CONFLICT(rfq_id, solver) DO UPDATE SET amount_out = excluded.amount_out, received_at = excluded.received_at`).run({ ...b, solver: b.solver.toLowerCase() });
    this.db.prepare(`UPDATE solvers SET bids = bids + 1, last_seen = ? WHERE address = ?`).run(b.received_at, b.solver.toLowerCase());
  }
  bids(rfqId: string): BidRow[] {
    return this.db.prepare(`SELECT * FROM bids WHERE rfq_id = ? ORDER BY CAST(amount_out AS INTEGER) DESC`).all(rfqId) as BidRow[];
  }

  insertOrder(o: SerializedSignedOrder, rfqId: string | null, now: number): void {
    this.db.prepare(`INSERT INTO orders (order_hash, seller, sell_token, buy_token, sell_amount, min_buy_amount, exclusive_solver, exclusive_until, deadline, rfq_id, json, created_at, updated_at)
      VALUES (@order_hash, @seller, @sell_token, @buy_token, @sell_amount, @min_buy_amount, @exclusive_solver, @exclusive_until, @deadline, @rfq_id, @json, @now, @now)`).run({
      order_hash: o.orderHash.toLowerCase(), seller: o.order.seller.toLowerCase(), sell_token: o.order.sellToken.toLowerCase(), buy_token: o.order.buyToken.toLowerCase(),
      sell_amount: o.order.sellAmount, min_buy_amount: o.order.minBuyAmount,
      exclusive_solver: o.order.exclusiveSolver === "0x0000000000000000000000000000000000000000" ? null : o.order.exclusiveSolver.toLowerCase(),
      exclusive_until: Number(o.order.exclusiveUntil), deadline: Number(o.order.deadline), rfq_id: rfqId, json: JSON.stringify(o), now,
    });
  }
  getOrder(hash: string): OrderRow | undefined {
    return this.db.prepare(`SELECT * FROM orders WHERE order_hash = ?`).get(hash.toLowerCase()) as OrderRow | undefined;
  }
  openOrders(): OrderRow[] {
    return this.db.prepare(`SELECT * FROM orders WHERE status = 'open' ORDER BY created_at`).all() as OrderRow[];
  }
  ordersBySeller(seller: string, limit = 50): OrderRow[] {
    return this.db.prepare(`SELECT * FROM orders WHERE seller = ? ORDER BY created_at DESC LIMIT ?`).all(seller.toLowerCase(), limit) as OrderRow[];
  }
  recentOrders(limit = 50): OrderRow[] {
    return this.db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`).all(limit) as OrderRow[];
  }
  markFilled(hash: string, txHash: string, buyAmount: string, solver: string, now: number): void {
    this.db.prepare(`UPDATE orders SET status = 'filled', tx_hash = ?, buy_amount = ?, solver = ?, updated_at = ? WHERE order_hash = ? AND status = 'open'`).run(txHash, buyAmount, solver.toLowerCase(), now, hash.toLowerCase());
    this.db.prepare(`UPDATE solvers SET fills = fills + 1 WHERE address = ?`).run(solver.toLowerCase());
  }
  markStatus(hash: string, status: OrderRow["status"], now: number, reason?: string): void {
    this.db.prepare(`UPDATE orders SET status = ?, fail_reason = COALESCE(?, fail_reason), updated_at = ? WHERE order_hash = ? AND status = 'open'`).run(status, reason ?? null, now, hash.toLowerCase());
  }
  expireStale(now: number): number {
    return this.db.prepare(`UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'open' AND deadline < ?`).run(now, now).changes;
  }

  upsertSolver(address: string, name: string, now: number): void {
    this.db.prepare(`INSERT INTO solvers (address, name, registered_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`).run(address.toLowerCase(), name, now, now);
  }
  solvers(): SolverRow[] {
    return this.db.prepare(`SELECT * FROM solvers ORDER BY fills DESC, bids DESC`).all() as SolverRow[];
  }

  v4Pools(pair: string) {
    return this.db.prepare(`SELECT * FROM v4_pools WHERE pair = ?`).all(pair) as Array<{ currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string; scanned_to: number }>;
  }
  v4ScannedTo(pair: string): number | undefined {
    const r = this.db.prepare(`SELECT MAX(scanned_to) AS b FROM v4_pools WHERE pair = ?`).get(pair) as { b: number | null };
    return r.b ?? undefined;
  }
  saveV4Pools(pair: string, keys: Array<{ currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }>, scannedTo: number): void {
    const stmt = this.db.prepare(`INSERT INTO v4_pools (pair, currency0, currency1, fee, tick_spacing, hooks, scanned_to) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pair, fee, tick_spacing, hooks) DO UPDATE SET scanned_to = excluded.scanned_to`);
    const tx = this.db.transaction(() => { for (const k of keys) stmt.run(pair, k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks, scannedTo); });
    tx();
  }

  cursor(k: string): number | undefined {
    return (this.db.prepare(`SELECT block FROM watch_cursor WHERE k = ?`).get(k) as { block: number } | undefined)?.block;
  }
  setCursor(k: string, block: number): void {
    this.db.prepare(`INSERT INTO watch_cursor (k, block) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET block = excluded.block`).run(k, block);
  }

  stats() {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      orders: one(`SELECT COUNT(*) AS n FROM orders`),
      filled: one(`SELECT COUNT(*) AS n FROM orders WHERE status = 'filled'`),
      open: one(`SELECT COUNT(*) AS n FROM orders WHERE status = 'open'`),
      rfqs: one(`SELECT COUNT(*) AS n FROM rfqs`),
      solvers: one(`SELECT COUNT(*) AS n FROM solvers`),
    };
  }

  close(): void {
    this.db.close();
  }
}
