/** In-process fan-out to connected solvers (SSE). */
export type BusEvent =
  | { type: "rfq"; rfq: { rfqId: string; tokenIn: string; tokenOut: string; amountIn: string; seller: string; expiresAt: number; baselineOut: string } }
  | { type: "order"; order: unknown }
  | { type: "filled"; orderHash: string; txHash: string; solver: string }
  | { type: "ping" };

export class Bus {
  private readonly listeners = new Set<(e: BusEvent) => void>();
  subscribe(fn: (e: BusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  publish(e: BusEvent): void {
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* a broken subscriber must not break the others */ }
    }
  }
  get size(): number {
    return this.listeners.size;
  }
}
