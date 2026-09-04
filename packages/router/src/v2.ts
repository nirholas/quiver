/** Uniswap v2 constant-product math (0.30% fee), exact to the contract's integer arithmetic. */
export function v2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

/** Price impact of a v2 trade in basis points, relative to the spot mid price. */
export function v2ImpactBps(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): number {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 10_000;
  const out = v2AmountOut(amountIn, reserveIn, reserveOut);
  const spotOut = (amountIn * reserveOut) / reserveIn;
  if (spotOut === 0n) return 10_000;
  return Number(((spotOut - out) * 10_000n) / spotOut);
}
