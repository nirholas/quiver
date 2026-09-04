import "dotenv/config";
import { createPublicClient, createWalletClient, http, publicActions, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, RPC_URL, buildInteractions, quote, settlementAbi, type PoolKey } from "@quiverdex/router";
import { deserializeSignedOrder, type SerializedSignedOrder } from "@quiverdex/sdk";
import { bidFor, fillFloor, mayFill } from "./math.js";

/**
 * Quiver reference solver. Subscribes to the API's SSE stream, bids on RFQs from the on-chain quote minus
 * its margin, and fills orders it won (or any unrestricted order) through QuiverSettlement after a
 * successful simulation. One key, one process. Everything it does another solver can do better.
 */
const API_URL = (process.env.QUIVER_API_URL ?? "http://localhost:4700").replace(/\/+$/, "");
const RPC = process.env.QUIVER_RPC_URL ?? RPC_URL;
const KEY = process.env.SOLVER_PRIVATE_KEY as Hex | undefined;
const NAME = process.env.SOLVER_NAME ?? "quiver-reference";
const MARGIN_BPS = BigInt(process.env.SOLVER_MARGIN_BPS ?? "5");
const MAX_GAS_WEI = BigInt(process.env.SOLVER_MAX_GAS_WEI ?? "2000000000000000"); // 0.002 ETH ceiling per fill
if (!KEY) {
  console.error("SOLVER_PRIVATE_KEY is required");
  process.exit(1);
}
const account = privateKeyToAccount(KEY);
const chain = { id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const client = createWalletClient({ account, chain, transport: http(RPC, { batch: true, retryCount: 3 }) }).extend(publicActions);
const reader = createPublicClient({ chain, transport: http(RPC, { batch: true, retryCount: 3 }) }) as PublicClient;

let settlement: Address;
const v4Cache = new Map<string, PoolKey[]>();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { "content-type": "application/json", accept: "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

async function register(): Promise<void> {
  const signature = await client.signMessage({ message: `quiver-solver:${NAME}` });
  await api("/solvers/register", { method: "POST", body: JSON.stringify({ address: account.address, name: NAME, signature }) });
  const manifest = await api<{ settlement: Address }>("/");
  settlement = getAddress(manifest.settlement);
  console.log(`[solver] ${NAME} ${account.address} registered; settlement ${settlement}`);
}

async function v4PoolsFor(tokenIn: Address, tokenOut: Address): Promise<PoolKey[]> {
  const key = [tokenIn.toLowerCase(), tokenOut.toLowerCase()].sort().join(":");
  if (!v4Cache.has(key)) {
    // The API already discovers and caches pool keys; reuse them through its quote endpoint's route hops.
    try {
      const q = await api<{ routes: Array<{ hops: Array<{ venue: string; poolKey?: PoolKey }> }> }>(`/quote?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=1000000`);
      const keys = q.routes.flatMap((r) => r.hops.filter((h) => h.venue === "uniswap-v4" && h.poolKey).map((h) => h.poolKey!));
      v4Cache.set(key, keys);
    } catch {
      v4Cache.set(key, []);
    }
  }
  return v4Cache.get(key)!;
}

async function onRfq(rfq: { rfqId: string; tokenIn: Address; tokenOut: Address; amountIn: string; expiresAt: number }): Promise<void> {
  const q = await quote(reader, rfq.tokenIn, rfq.tokenOut, BigInt(rfq.amountIn), { v4Pools: await v4PoolsFor(rfq.tokenIn, rfq.tokenOut) });
  if (q.amountOut === 0n) return;
  const bid = bidFor(q.amountOut, MARGIN_BPS);
  if (Date.now() > rfq.expiresAt) return;
  const signature = await client.signMessage({ message: `quiver-bid:${rfq.rfqId}:${bid}` });
  const res = await api<{ leading: boolean }>("/bids", { method: "POST", body: JSON.stringify({ rfqId: rfq.rfqId, amountOut: bid.toString(), solver: account.address, signature }) });
  console.log(`[solver] bid ${bid} on ${rfq.rfqId} (quote ${q.amountOut}) leading=${res.leading}`);
}

async function onOrder(payload: SerializedSignedOrder): Promise<void> {
  const signed = deserializeSignedOrder(payload);
  const o = signed.order;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!mayFill(o, account.address, nowSec)) return; // someone else's window; the sweep retries after it lapses
  // The stream and the periodic sweep can both deliver the same order; never re-simulate one that is no longer open.
  const current = await api<{ status: string }>(`/orders/${signed.orderHash}`).catch(() => ({ status: "open" }));
  if (current.status !== "open") return;
  const q = await quote(reader, o.sellToken, o.buyToken, o.sellAmount, { v4Pools: await v4PoolsFor(o.sellToken, o.buyToken) });
  const floor = fillFloor(o.minBuyAmount, MARGIN_BPS);
  if (q.amountOut < floor) {
    console.log(`[solver] skip ${signed.orderHash}: quote ${q.amountOut} < floor ${floor}`);
    return;
  }
  const deadline = BigInt(nowSec + 120);
  const interactions = buildInteractions(q.routes, o.minBuyAmount, deadline);
  const args = [o, signed.permitNonce, signed.permitDeadline, signed.signature, interactions] as const;
  try {
    const { request, result } = await client.simulateContract({ address: settlement, abi: settlementAbi, functionName: "settle", args, account });
    const gas = await client.estimateContractGas({ address: settlement, abi: settlementAbi, functionName: "settle", args, account }).catch(() => 800_000n);
    const fees = await client.estimateFeesPerGas();
    const gasCost = gas * (fees.maxFeePerGas ?? 0n);
    if (gasCost > MAX_GAS_WEI) {
      console.log(`[solver] skip ${signed.orderHash}: gas ${gasCost} wei over ceiling`);
      return;
    }
    const hash = await client.writeContract({ ...request, gas: (gas * 12n) / 10n });
    console.log(`[solver] settling ${signed.orderHash} for ${result} via ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`[solver] ${receipt.status} ${hash} gasUsed ${receipt.gasUsed}`);
  } catch (error) {
    console.log(`[solver] simulation failed for ${signed.orderHash}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
}

async function subscribe(): Promise<void> {
  const res = await fetch(`${API_URL}/solvers/stream`, { headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);
  console.log("[solver] connected to solver stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      try {
        const parsed = JSON.parse(data) as { rfq?: Parameters<typeof onRfq>[0]; order?: SerializedSignedOrder };
        if (event === "rfq" && parsed.rfq) void onRfq(parsed.rfq).catch((e) => console.log(`[solver] rfq error: ${e}`));
        if (event === "order" && parsed.order) void onOrder(parsed.order).catch((e) => console.log(`[solver] order error: ${e}`));
      } catch {
        // ignore malformed frames
      }
    }
  }
  throw new Error("stream ended");
}

async function sweepOpenOrders(): Promise<void> {
  const open = await api<SerializedSignedOrder[]>("/orders/open/all").catch(() => []);
  for (const o of open) await onOrder(o).catch(() => undefined);
}

async function main(): Promise<void> {
  await register();
  await sweepOpenOrders();
  setInterval(() => void sweepOpenOrders(), 30_000);
  for (;;) {
    try {
      await subscribe();
    } catch (error) {
      console.log(`[solver] stream error: ${error instanceof Error ? error.message : error}; reconnecting`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

void main();
