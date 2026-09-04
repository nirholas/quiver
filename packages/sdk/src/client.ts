import type { Address, Hex } from "viem";
import { serializeSignedOrder, type SerializedSignedOrder, type SignedOrder } from "./order.js";

export type ApiQuote = {
  tokenIn: Address; tokenOut: Address; amountIn: string; amountOut: string;
  routes: Array<{ venues: string[]; amountIn: string; amountOut: string }>;
  bestDirect?: { venue: string; amountOut: string };
  blockNumber: string; quotedAt: number;
};

export type Rfq = {
  rfqId: string;
  tokenIn: Address; tokenOut: Address; amountIn: string;
  /** Best bid after the auction window. */
  best?: { solver: Address; amountOut: string; exclusiveUntil: string };
  bids: Array<{ solver: Address; amountOut: string; receivedAt: number }>;
  baseline: { amountOut: string; venue?: string };
  expiresAt: number;
};

export type OrderStatus = {
  orderHash: Hex;
  status: "open" | "filled" | "expired" | "cancelled" | "failed";
  txHash?: Hex;
  buyAmount?: string;
  solver?: Address;
  createdAt: number;
  updatedAt: number;
};

/** Thin client for a Quiver API. */
export class QuiverApi {
  constructor(readonly baseUrl: string, private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async quote(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<ApiQuote> {
    return this.get(`/quote?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`);
  }

  /** Start an RFQ auction. Solvers bid for `windowMs`; the best bid gets exclusivity once the order is signed. */
  async rfq(tokenIn: Address, tokenOut: Address, amountIn: bigint, seller: Address): Promise<Rfq> {
    return this.post(`/rfq`, { tokenIn, tokenOut, amountIn: amountIn.toString(), seller });
  }

  async getRfq(rfqId: string): Promise<Rfq> {
    return this.get(`/rfq/${rfqId}`);
  }

  async submit(signed: SignedOrder, rfqId?: string): Promise<OrderStatus> {
    return this.post(`/orders`, { ...serializeSignedOrder(signed), rfqId });
  }

  async status(orderHash: Hex): Promise<OrderStatus> {
    return this.get(`/orders/${orderHash}`);
  }

  async settlementAddress(): Promise<Address> {
    const m = (await this.get(`/`)) as { settlement: Address };
    return m.settlement;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Quiver API ${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Quiver API ${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    return (await res.json()) as T;
  }
}

export type { SerializedSignedOrder };
