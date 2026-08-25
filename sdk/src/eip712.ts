import { EIP712Domain, PaymentAuthorization } from "./types";

/** EIP-712 type definition for a single payment authorization. Matches the
 * field order/types an on-chain verifier would expect if this MVP is later
 * upgraded to verify signatures in the contract itself (see roadmap). */
export const PAYMENT_AUTHORIZATION_TYPES = {
  PaymentAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "amountMicros", type: "uint256" },
    { name: "serviceId", type: "string" },
    { name: "nonce", type: "string" },
    { name: "expiry", type: "uint256" },
  ],
};

export function buildDomain(chainId: number, verifyingContract: string): EIP712Domain {
  return {
    name: "BatchedSettlementAgent",
    version: "1",
    chainId,
    verifyingContract,
  };
}

/** ethers' TypedDataEncoder expects amountMicros/expiry as actual numbers or
 * bigints, not strings — this converts our JSON-transportable authorization
 * into the shape ethers needs for signing/verification. */
export function toTypedValue(auth: PaymentAuthorization) {
  return {
    from: auth.from,
    to: auth.to,
    amountMicros: BigInt(auth.amountMicros),
    serviceId: auth.serviceId,
    nonce: auth.nonce,
    expiry: auth.expiry,
  };
}
