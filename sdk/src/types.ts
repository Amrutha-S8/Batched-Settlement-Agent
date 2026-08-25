/**
 * The signed message an agent produces to instantly authorize a
 * micro-payment. Modeled on the x402 pattern (HTTP 402 Payment Required ->
 * client attaches a signed payment proof) but scoped to *this* clearinghouse
 * as an EIP-712 typed message so it can be verified fully offline by the
 * receiving service before it does any work, with zero on-chain round trip.
 */
export interface PaymentAuthorization {
  from: string;
  to: string;
  amountMicros: string; // bigint serialized as decimal string for JSON transport
  serviceId: string;
  nonce: string;
  expiry: number; // unix seconds after which the authorization is void
}

export interface SignedPaymentAuthorization {
  authorization: PaymentAuthorization;
  signature: string;
}

export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}
