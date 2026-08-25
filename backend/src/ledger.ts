import { MicroPayment } from "../../netting-engine/src/index";

/**
 * In-memory ledger for the demo backend. A production deployment would
 * back this with a real database (and probably a queue), but the shape is
 * the same: append-only pending payments since the last settlement, plus a
 * seen-nonce set for replay protection.
 */
class Ledger {
  private pending: MicroPayment[] = [];
  private seenNonces = new Set<string>();
  private outstandingByAgent = new Map<string, bigint>();

  hasSeenNonce(nonce: string): boolean {
    return this.seenNonces.has(nonce);
  }

  addPayment(payment: MicroPayment) {
    this.seenNonces.add(payment.nonce);
    this.pending.push(payment);
    this.outstandingByAgent.set(payment.from, (this.outstandingByAgent.get(payment.from) ?? 0n) + payment.amountMicros);
  }

  outstandingFor(agent: string): bigint {
    return this.outstandingByAgent.get(agent) ?? 0n;
  }

  getPending(): MicroPayment[] {
    return [...this.pending];
  }

  stats() {
    const agents = new Set<string>();
    let volume = 0n;
    for (const p of this.pending) {
      agents.add(p.from);
      agents.add(p.to);
      volume += p.amountMicros;
    }
    return {
      pendingCount: this.pending.length,
      distinctAgents: agents.size,
      totalVolumeMicros: volume.toString(),
    };
  }

  /** Called after a successful on-chain settlement. */
  clear() {
    this.pending = [];
    this.outstandingByAgent.clear();
    // Intentionally NOT clearing seenNonces — authorizations should never
    // be replayable even across settlement cycles.
  }
}

export const ledger = new Ledger();
