/**
 * Atomic token amounts are uint256 decimal strings. They routinely exceed the signed 64-bit range
 * that SQLite integers and JS numbers can hold (10 tokens of an 18-decimal asset is already past it),
 * so every comparison and every validation of an amount goes through BigInt here.
 */
export const UINT256_MAX = (1n << 256n) - 1n;

/** Canonical decimal form of an atomic amount ("007" -> "7"), or null when it is not a uint256. */
export function canonicalAmount(raw: string): string | null {
  if (!/^\d{1,78}$/.test(raw)) return null;
  const value = BigInt(raw);
  return value > UINT256_MAX ? null : value.toString();
}

/** Orders two amount strings by numeric value: negative when a < b, positive when a > b. */
export function compareAmounts(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
