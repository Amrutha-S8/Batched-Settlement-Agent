import { keccak256, toUtf8Bytes } from "ethers";
import { MicroPayment } from "./types";

/**
 * Anchors the full off-chain micro-payment set for a batch to a single
 * on-chain hash. The raw payment list (with each x402 authorization's
 * signature) should be published somewhere durable and content-addressed —
 * IPFS or Arweave are natural fits — and this hash is what settleBatch()
 * records on-chain, so anyone can later fetch the raw data and verify the
 * netting engine's output matches it. This is the auditability half of the
 * MVP's trust model; it does not by itself let an agent contest a bad batch
 * on-chain (that needs the fraud-proof/ZK layer described in the roadmap).
 */
export function commitmentHashFor(payments: MicroPayment[]): string {
  const sorted = [...payments].sort((a, b) => a.nonce.localeCompare(b.nonce));
  const serialized = sorted
    .map((p) => `${p.from}|${p.to}|${p.amountMicros.toString()}|${p.serviceId}|${p.nonce}|${p.timestamp}`)
    .join("\n");
  return keccak256(toUtf8Bytes(serialized));
}
