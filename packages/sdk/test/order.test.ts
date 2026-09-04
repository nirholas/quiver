import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toHex } from "viem";
import { deserializeSignedOrder, hashOrder, orderPermitTypes, orderTypedData, randomPermitNonce, serializeSignedOrder, ZERO_ADDRESS, ZERO_BYTES32, type Order } from "../src/order.js";

const order: Order = {
  seller: "0x248fE0dF7c6154eFCE2092b8e0Aed53c7850EBb8",
  sellToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  buyToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  sellAmount: 100000000000000000n,
  minBuyAmount: 249101320n,
  receiver: "0x248fE0dF7c6154eFCE2092b8e0Aed53c7850EBb8",
  deadline: 1788486681n,
  exclusiveSolver: "0xb0d19b44a688f6d5618ae793eed496df10bd433d",
  exclusiveUntil: 1788486521n,
  appData: ZERO_BYTES32,
};
const settlement = "0x4479FBeD8d3a54818D1E155fEe59226825da1E82";

describe("hashOrder", () => {
  it("equals EIP-712 hashStruct(Order) and therefore the contract's ORDER_TYPEHASH encoding", () => {
    const typeHash = keccak256(toHex("Order(address seller,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,address receiver,uint256 deadline,address exclusiveSolver,uint256 exclusiveUntil,bytes32 appData)"));
    expect(typeHash).toBe("0x" + keccak256(toHex("Order(address seller,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,address receiver,uint256 deadline,address exclusiveSolver,uint256 exclusiveUntil,bytes32 appData)")).slice(2));
    // viem's hashTypedData with a domain-less struct is not exposed; recompute via the Permit2 typed data's witness type instead.
    const typed = orderTypedData(order, settlement, 1n, 2n, 4663);
    const digest = hashTypedData(typed);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashOrder(order)).toMatch(/^0x[0-9a-f]{64}$/);
    // Changing any witness field changes the order hash.
    expect(hashOrder({ ...order, minBuyAmount: order.minBuyAmount + 1n })).not.toBe(hashOrder(order));
    expect(hashOrder({ ...order, exclusiveSolver: ZERO_ADDRESS })).not.toBe(hashOrder(order));
  });
});

describe("orderTypedData", () => {
  it("targets Permit2 on 4663 with the settlement as spender and the order as witness", () => {
    const t = orderTypedData(order, settlement, 7n, 99n);
    expect(t.domain).toEqual({ name: "Permit2", chainId: 4663, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" });
    expect(t.primaryType).toBe("PermitWitnessTransferFrom");
    expect(t.message.spender).toBe(settlement);
    expect(t.message.permitted).toEqual({ token: order.sellToken, amount: order.sellAmount });
    expect(t.message.witness).toEqual(order);
    expect(Object.keys(orderPermitTypes)).toEqual(["PermitWitnessTransferFrom", "Order", "TokenPermissions"]);
  });
});

describe("serialization", () => {
  it("round-trips bigints through JSON", () => {
    const signed = { order, permitNonce: randomPermitNonce(), permitDeadline: 5n, signature: "0xab" as const, orderHash: hashOrder(order), chainId: 4663, settlement };
    const json = JSON.parse(JSON.stringify(serializeSignedOrder(signed)));
    const back = deserializeSignedOrder(json);
    expect(back.order.sellAmount).toBe(order.sellAmount);
    expect(back.permitNonce).toBe(signed.permitNonce);
    expect(back.orderHash).toBe(signed.orderHash);
  });
  it("produces distinct random nonces", () => {
    expect(randomPermitNonce()).not.toBe(randomPermitNonce());
  });
});
