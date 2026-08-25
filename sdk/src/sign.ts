import { Signer, verifyTypedData } from "ethers";
import { EIP712Domain, PaymentAuthorization, SignedPaymentAuthorization } from "./types";
import { PAYMENT_AUTHORIZATION_TYPES, toTypedValue } from "./eip712";

export async function signAuthorization(
  signer: Signer,
  domain: EIP712Domain,
  authorization: PaymentAuthorization
): Promise<SignedPaymentAuthorization> {
  const signature = await signer.signTypedData(domain, PAYMENT_AUTHORIZATION_TYPES, toTypedValue(authorization));
  return { authorization, signature };
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  recoveredSigner?: string;
}

/**
 * Fully offline verification — the whole point of x402-style instant pay.
 * The receiving service can validate this in microseconds with zero chain
 * calls: recover the signer, confirm it matches the claimed payer, and
 * confirm the authorization hasn't expired. Nonce-replay protection (has
 * this exact nonce been spent before?) is the caller's responsibility since
 * it requires the service's own ledger state, not anything derivable from
 * the signature alone.
 */
export function verifyAuthorization(domain: EIP712Domain, signed: SignedPaymentAuthorization, nowUnixSeconds: number = Math.floor(Date.now() / 1000)): VerificationResult {
  const { authorization, signature } = signed;

  if (authorization.expiry < nowUnixSeconds) {
    return { valid: false, reason: "expired" };
  }

  let recoveredSigner: string;
  try {
    recoveredSigner = verifyTypedData(domain, PAYMENT_AUTHORIZATION_TYPES, toTypedValue(authorization), signature);
  } catch {
    return { valid: false, reason: "malformed_signature" };
  }

  if (recoveredSigner.toLowerCase() !== authorization.from.toLowerCase()) {
    return { valid: false, reason: "signer_mismatch", recoveredSigner };
  }

  return { valid: true, recoveredSigner };
}
