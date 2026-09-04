import { encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, type Address, type Hex } from "viem";
import { UNISWAP_UNIVERSAL_ROUTER } from "./addresses.js";
import { erc20Abi, universalRouterAbi } from "./abis.js";
import type { Route } from "./quote.js";

export type Interaction = { target: Address; value: bigint; data: Hex };

/** UniversalRouter command bytes. */
const CMD_V3_SWAP_EXACT_IN = 0x00;
const CMD_V2_SWAP_EXACT_IN = 0x08;
const CMD_V4_SWAP = 0x10;
/** v4 router actions. */
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE = 0x0b;
const ACT_TAKE = 0x0e;
/** ActionConstants. */
const CONTRACT_BALANCE = 0n;
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as const;
const MSG_SENDER = "0x0000000000000000000000000000000000000001" as const;

/**
 * Compile a route set into the calls QuiverSettlement executes. One UniversalRouter.execute per route:
 * the settlement contract transfers the route's input to the router, every hop is paid from the router's
 * own balance (payerIsUser = false / SETTLE from CONTRACT_BALANCE), intermediate outputs stay in the router
 * (recipient ADDRESS_THIS), and the final hop pays MSG_SENDER, which inside the router resolves to the
 * settlement contract. No Permit2 allowances, no leftover intermediates, exact amounts end to end.
 *
 * Each route carries a proportional share of `minOutTotal` on its last hop so a single leg cannot
 * silently underdeliver; the settlement contract still enforces the seller's total limit on top.
 */
export function buildInteractions(routes: Route[], minOutTotal: bigint, deadline: bigint): Interaction[] {
  const totalQuoted = routes.reduce((s, r) => s + r.amountOut, 0n);
  const ix: Interaction[] = [];
  for (const route of routes) {
    if (route.hops.length === 0) continue;
    const minOut = totalQuoted === 0n ? 0n : (minOutTotal * route.amountOut) / totalQuoted;
    const tokenIn = getAddress(route.hops[0]!.tokenIn);
    ix.push({ target: tokenIn, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [UNISWAP_UNIVERSAL_ROUTER, route.amountIn] }) });

    const commands: number[] = [];
    const inputs: Hex[] = [];
    route.hops.forEach((hop, i) => {
      const last = i === route.hops.length - 1;
      const recipient = last ? MSG_SENDER : ADDRESS_THIS;
      const amountIn = i === 0 ? route.amountIn : CONTRACT_BALANCE;
      const legMin = last ? minOut : 0n;
      const hin = getAddress(hop.tokenIn);
      const hout = getAddress(hop.tokenOut);
      if (hop.venue === "uniswap-v3") {
        commands.push(CMD_V3_SWAP_EXACT_IN);
        const path = encodePacked(["address", "uint24", "address"], [hin, hop.fee, hout]);
        inputs.push(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }], [recipient, amountIn, legMin, path, false]));
      } else if (hop.venue === "uniswap-v2") {
        commands.push(CMD_V2_SWAP_EXACT_IN);
        inputs.push(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "address[]" }, { type: "bool" }], [recipient, amountIn, legMin, [hin, hout], false]));
      } else {
        commands.push(CMD_V4_SWAP);
        const key = hop.poolKey;
        const zeroForOne = hin.toLowerCase() === key.currency0.toLowerCase();
        const actions = encodePacked(["uint8", "uint8", "uint8"], [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE]);
        const swapParams = encodeAbiParameters(
          [{ type: "tuple", components: [
            { type: "tuple", name: "poolKey", components: [{ type: "address", name: "currency0" }, { type: "address", name: "currency1" }, { type: "uint24", name: "fee" }, { type: "int24", name: "tickSpacing" }, { type: "address", name: "hooks" }] },
            { type: "bool", name: "zeroForOne" }, { type: "uint128", name: "amountIn" }, { type: "uint128", name: "amountOutMinimum" }, { type: "bytes", name: "hookData" },
          ] }],
          [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: legMin, hookData: "0x" }],
        );
        const settleParams = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [hin, CONTRACT_BALANCE, false]);
        const takeParams = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [hout, recipient, 0n]);
        inputs.push(encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settleParams, takeParams]]));
      }
    });
    ix.push({
      target: UNISWAP_UNIVERSAL_ROUTER,
      value: 0n,
      data: encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [encodePacked(commands.map(() => "uint8" as const), commands), inputs, deadline] }),
    });
  }
  return ix;
}
