import { Signer } from "ethers";
import { EIP712Domain, PaymentAuthorization, SignedPaymentAuthorization } from "./types";
import { signAuthorization } from "./sign";

export interface AgentWalletOptions {
  domain: EIP712Domain;
  /** The agent's own off-chain credit limit, mirroring AgentRegistry's
   * tiered limits on-chain. The wallet enforces this locally so an agent
   * never even attempts to over-authorize — the backend/operator
   * independently re-checks the same limit server-side, so this is a
   * client-side courtesy, not the security boundary. */
  creditLimitMicros: bigint;
  /** How long a signed authorization remains valid if not consumed. */
  defaultExpirySeconds?: number;
}

/**
 * Minimal agent-side wallet: wraps a signer, tracks the agent's own running
 * unsettled tab, and produces instantly-verifiable x402-style payment
 * authorizations. This is deliberately NOT a full wallet (no key
 * management UI, no multi-chain support) — it's the payment-authorization
 * primitive an AI agent's runtime would call between HTTP requests.
 */
export class AgentWallet {
  readonly address: string;
  private signer: Signer;
  private domain: EIP712Domain;
  private creditLimitMicros: bigint;
  private defaultExpirySeconds: number;
  private outstandingMicros = 0n; // sum of authorizations issued since last settlement
  private nonceCounter = 0;

  private constructor(signer: Signer, address: string, options: AgentWalletOptions) {
    this.signer = signer;
    this.address = address;
    this.domain = options.domain;
    this.creditLimitMicros = options.creditLimitMicros;
    this.defaultExpirySeconds = options.defaultExpirySeconds ?? 300;
  }

  static async create(signer: Signer, options: AgentWalletOptions): Promise<AgentWallet> {
    const address = await signer.getAddress();
    return new AgentWallet(signer, address, options);
  }

  get outstandingBalanceMicros(): bigint {
    return this.outstandingMicros;
  }

  get availableCreditMicros(): bigint {
    const remaining = this.creditLimitMicros - this.outstandingMicros;
    return remaining > 0n ? remaining : 0n;
  }

  /**
   * Instantly authorize a micro-payment for a service call. This never
   * touches the chain — the returned signed authorization is what gets
   * attached to the API request (e.g. as an HTTP header, mirroring x402's
   * "X-PAYMENT" pattern) so the service can verify and fulfill in the same
   * request/response cycle.
   */
  async pay(to: string, amountMicros: bigint, serviceId: string): Promise<SignedPaymentAuthorization> {
    if (amountMicros <= 0n) throw new Error("AgentWallet: amount must be positive");
    if (amountMicros > this.availableCreditMicros) {
      throw new Error(
        `AgentWallet: would exceed credit limit (available ${this.availableCreditMicros}, requested ${amountMicros})`
      );
    }

    const authorization: PaymentAuthorization = {
      from: this.address,
      to,
      amountMicros: amountMicros.toString(),
      serviceId,
      nonce: this.nextNonce(),
      expiry: Math.floor(Date.now() / 1000) + this.defaultExpirySeconds,
    };

    const signed = await signAuthorization(this.signer, this.domain, authorization);
    this.outstandingMicros += amountMicros;
    return signed;
  }

  /** Called once a batch settlement clears this agent's obligations
   * on-chain, resetting the local tab so new credit becomes available. */
  onSettled(settledMicros: bigint) {
    this.outstandingMicros = this.outstandingMicros > settledMicros ? this.outstandingMicros - settledMicros : 0n;
  }

  updateCreditLimit(newLimitMicros: bigint) {
    this.creditLimitMicros = newLimitMicros;
  }

  private nextNonce(): string {
    this.nonceCounter += 1;
    return `${this.address}-${Date.now()}-${this.nonceCounter}`;
  }
}
