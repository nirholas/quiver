/** Bid at the on-chain quote minus the solver's margin. */
export function bidFor(quoteOut: bigint, marginBps: bigint): bigint {
  return (quoteOut * (10_000n - marginBps)) / 10_000n;
}

/** The lowest quote at which filling an order still clears the solver's margin over the seller's floor. */
export function fillFloor(minBuyAmount: bigint, marginBps: bigint): bigint {
  return (minBuyAmount * (10_000n + marginBps)) / 10_000n;
}

/** Whether this solver may act on an order right now given its exclusivity window. */
export function mayFill(order: { exclusiveSolver: string; exclusiveUntil: bigint }, self: string, nowSec: number): boolean {
  const zero = "0x0000000000000000000000000000000000000000";
  if (order.exclusiveSolver.toLowerCase() === zero) return true;
  if (order.exclusiveSolver.toLowerCase() === self.toLowerCase()) return true;
  return Number(order.exclusiveUntil) < nowSec;
}
