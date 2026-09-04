import { encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hex, type TypedDataDomain } from "viem";
import { PERMIT2, CHAIN_ID } from "@quiverdex/router";

export type Order = {
  seller: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  minBuyAmount: bigint;
  receiver: Address;
  deadline: bigint;
  exclusiveSolver: Address;
  exclusiveUntil: bigint;
  appData: Hex;
};

export type SignedOrder = {
  order: Order;
  permitNonce: bigint;
  permitDeadline: bigint;
  signature: Hex;
  orderHash: Hex;
  chainId: number;
  settlement: Address;
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;

/** EIP-712 types for the Permit2 witness transfer whose witness is a Quiver order. Alphabetical after the primary type. */
export const orderPermitTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Order" },
  ],
  Order: [
    { name: "seller", type: "address" },
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "minBuyAmount", type: "uint256" },
    { name: "receiver", type: "address" },
    { name: "deadline", type: "uint256" },
    { name: "exclusiveSolver", type: "address" },
    { name: "exclusiveUntil", type: "uint256" },
    { name: "appData", type: "bytes32" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

export function permit2Domain(chainId: number = CHAIN_ID): TypedDataDomain {
  return { name: "Permit2", chainId, verifyingContract: PERMIT2 };
}

/** The typed data a wallet signs. One signature authorizes the transfer and fixes every order term. */
export function orderTypedData(order: Order, settlement: Address, permitNonce: bigint, permitDeadline: bigint, chainId: number = CHAIN_ID) {
  return {
    domain: permit2Domain(chainId),
    types: orderPermitTypes,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: {
      permitted: { token: order.sellToken, amount: order.sellAmount },
      spender: getAddress(settlement),
      nonce: permitNonce,
      deadline: permitDeadline,
      witness: order,
    },
  };
}

/** A fresh Permit2 unordered nonce: random 248-bit word index, random bit. Collisions are negligible; a used nonce simply fails. */
export function randomPermitNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return BigInt(toHex(bytes));
}

/** EIP-712 typehash of the Order struct, identical to QuiverSettlement.ORDER_TYPEHASH. */
export const ORDER_TYPEHASH: Hex = keccak256(
  toHex(
    "Order(address seller,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,address receiver,uint256 deadline,address exclusiveSolver,uint256 exclusiveUntil,bytes32 appData)",
  ),
);

/**
 * keccak256(abi.encode(ORDER_TYPEHASH, ...fields)), byte-identical to QuiverSettlement.hashOrder and to the
 * Permit2 witness the seller signs. Built with viem's ABI encoder rather than hand-assembled hex so field
 * padding cannot drift from the contract.
 */
export function hashOrder(order: Order): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" },
        { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" },
      ],
      [
        ORDER_TYPEHASH, getAddress(order.seller), getAddress(order.sellToken), getAddress(order.buyToken), order.sellAmount,
        order.minBuyAmount, getAddress(order.receiver), order.deadline, getAddress(order.exclusiveSolver), order.exclusiveUntil, order.appData,
      ],
    ),
  );
}

export type SignTypedData = (args: ReturnType<typeof orderTypedData>) => Promise<Hex>;

export async function signOrder(
  order: Order,
  settlement: Address,
  signTypedData: SignTypedData,
  opts: { permitNonce?: bigint; permitDeadline?: bigint; chainId?: number } = {},
): Promise<SignedOrder> {
  const permitNonce = opts.permitNonce ?? randomPermitNonce();
  const permitDeadline = opts.permitDeadline ?? order.deadline;
  const chainId = opts.chainId ?? CHAIN_ID;
  const signature = await signTypedData(orderTypedData(order, settlement, permitNonce, permitDeadline, chainId));
  return { order, permitNonce, permitDeadline, signature, orderHash: hashOrder(order), chainId, settlement: getAddress(settlement) };
}

/** JSON-safe form for the API. */
export function serializeSignedOrder(s: SignedOrder) {
  return {
    order: { ...s.order, sellAmount: s.order.sellAmount.toString(), minBuyAmount: s.order.minBuyAmount.toString(), deadline: s.order.deadline.toString(), exclusiveUntil: s.order.exclusiveUntil.toString() },
    permitNonce: s.permitNonce.toString(),
    permitDeadline: s.permitDeadline.toString(),
    signature: s.signature,
    orderHash: s.orderHash,
    chainId: s.chainId,
    settlement: s.settlement,
  };
}

export type SerializedSignedOrder = ReturnType<typeof serializeSignedOrder>;

export function deserializeSignedOrder(j: SerializedSignedOrder): SignedOrder {
  return {
    order: { ...j.order, sellAmount: BigInt(j.order.sellAmount), minBuyAmount: BigInt(j.order.minBuyAmount), deadline: BigInt(j.order.deadline), exclusiveUntil: BigInt(j.order.exclusiveUntil) } as Order,
    permitNonce: BigInt(j.permitNonce),
    permitDeadline: BigInt(j.permitDeadline),
    signature: j.signature as Hex,
    orderHash: j.orderHash as Hex,
    chainId: j.chainId,
    settlement: j.settlement as Address,
  };
}
