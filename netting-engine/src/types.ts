/** A single off-chain, x402-authorized micro-payment between two agents. */
export interface MicroPayment {
  from: string; // payer agent address
  to: string; // payee agent address
  amountMicros: bigint; // amount in the settlement token's smallest unit (e.g. 6-decimal USDC "micros")
  serviceId: string; // what was purchased (api call, data feed, compute, etc.)
  nonce: string; // unique id of the underlying x402 authorization
  timestamp: number; // unix ms
}

/** An agent's net position after aggregating all micro-payments in a cycle.
 * Positive = net creditor (owed money). Negative = net debtor (owes money). */
export interface NetPosition {
  agent: string;
  netMicros: bigint;
}

/** A single minimized on-chain transfer produced by the netting algorithm. */
export interface NetTransfer {
  from: string;
  to: string;
  amountMicros: bigint;
}

export interface CreditLimits {
  [agent: string]: bigint;
}

export interface NettingResult {
  transfers: NetTransfer[];
  rawTransactionCount: number;
  netTransferCount: number;
  totalVolumeMicros: bigint;
  reductionPct: number; // how much smaller the settlement set is vs. raw tx count
  commitmentHash: string;
  forcedEarlySettlement: string[]; // agents that breached their credit limit mid-cycle
}
