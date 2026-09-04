import { describe, expect, it } from "vitest";
import { bidFor, fillFloor, mayFill } from "../src/math.js";

describe("solver math", () => {
  it("bids below the quote by the margin and requires the quote to clear the floor by the margin", () => {
    expect(bidFor(250_000_000n, 5n)).toBe(249_875_000n);
    expect(fillFloor(249_101_320n, 5n)).toBe(249_225_870n);
    expect(bidFor(1n, 5n)).toBe(0n);
  });
  it("respects exclusivity windows", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const me = "0xb0d19B44a688f6d5618AE793eeD496Df10Bd433d", other = "0x1111111111111111111111111111111111111111";
    expect(mayFill({ exclusiveSolver: zero, exclusiveUntil: 0n }, me, 100)).toBe(true);
    expect(mayFill({ exclusiveSolver: me.toLowerCase(), exclusiveUntil: 200n }, me, 100)).toBe(true);
    expect(mayFill({ exclusiveSolver: other, exclusiveUntil: 200n }, me, 100)).toBe(false);
    expect(mayFill({ exclusiveSolver: other, exclusiveUntil: 200n }, me, 201)).toBe(true);
  });
});
