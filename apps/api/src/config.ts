import { z } from "zod";
import { RPC_URL } from "@quiverdex/router";

const schema = z.object({
  QUIVER_RPC_URL: z.string().url().default(RPC_URL),
  QUIVER_SETTLEMENT: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  QUIVER_API_PORT: z.coerce.number().int().positive().default(4700),
  QUIVER_DB: z.string().default("./data/quiver.db"),
  /** How long solvers get to bid on an RFQ. */
  QUIVER_RFQ_WINDOW_MS: z.coerce.number().int().positive().default(1500),
  /** Exclusivity the winning solver receives once the seller signs. */
  QUIVER_EXCLUSIVITY_SECONDS: z.coerce.number().int().positive().default(20),
  /** Default order lifetime offered to the UI. */
  QUIVER_ORDER_TTL_SECONDS: z.coerce.number().int().positive().default(180),
  /** Blocks of PoolManager history to scan for v4 pools per pair (cached). */
  QUIVER_V4_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(200_000),
  /** Settled-log poll interval. */
  QUIVER_WATCH_MS: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().optional(),
});

export type ApiConfig = {
  rpcUrl: string;
  settlement: `0x${string}`;
  port: number;
  dbPath: string;
  rfqWindowMs: number;
  exclusivitySeconds: number;
  orderTtlSeconds: number;
  v4LookbackBlocks: number;
  watchMs: number;
  publicUrl?: string;
};

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const p = schema.parse(env);
  return {
    rpcUrl: p.QUIVER_RPC_URL,
    settlement: p.QUIVER_SETTLEMENT as `0x${string}`,
    port: p.QUIVER_API_PORT,
    dbPath: p.QUIVER_DB,
    rfqWindowMs: p.QUIVER_RFQ_WINDOW_MS,
    exclusivitySeconds: p.QUIVER_EXCLUSIVITY_SECONDS,
    orderTtlSeconds: p.QUIVER_ORDER_TTL_SECONDS,
    v4LookbackBlocks: p.QUIVER_V4_LOOKBACK_BLOCKS,
    watchMs: p.QUIVER_WATCH_MS,
    publicUrl: p.PUBLIC_URL,
  };
}
