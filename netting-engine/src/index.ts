import { MicroPayment, NettingResult, CreditLimits } from "./types";
import { computeNetPositions } from "./netPositions";
import { greedyMinTransfers, exactMinTransfers } from "./minimizeTransfers";
import { findCreditLimitBreaches } from "./creditLimits";
import { commitmentHashFor } from "./commitment";

export * from "./types";
export * from "./netPositions";
export * from "./minimizeTransfers";
export * from "./creditLimits";
export * from "./commitment";

export interface RunNettingCycleOptions {
  /** Use the exact (NP-hard) solver instead of the greedy heuristic when
   * the number of agents with a nonzero balance is small enough to be
   * tractable. Defaults to true — it's a free upgrade below the threshold. */
  useExactWhenSmall?: boolean;
  exactSolverMaxAgents?: number;
  creditLimits?: CreditLimits;
}

/**
 * The full netting pipeline: raw micro-payments in, minimized settlement
 * batch out. This is the core mechanism that makes agentic micro-commerce
 * economical — collapsing what could be thousands of sub-cent payments into
 * a handful of on-chain transfers.
 */
export function runNettingCycle(payments: MicroPayment[], options: RunNettingCycleOptions = {}): NettingResult {
  const { useExactWhenSmall = true, exactSolverMaxAgents = 12, creditLimits = {} } = options;

  const netPositions = computeNetPositions(payments);

  const forcedEarlySettlement = findCreditLimitBreaches(netPositions, creditLimits);

  let transfers = useExactWhenSmall && netPositions.size <= exactSolverMaxAgents ? exactMinTransfers(netPositions, exactSolverMaxAgents) : null;

  if (!transfers) {
    transfers = greedyMinTransfers(netPositions);
  }

  const totalVolumeMicros = transfers.reduce((sum, t) => sum + t.amountMicros, 0n);
  const rawTransactionCount = payments.length;
  const netTransferCount = transfers.length;
  const reductionPct = rawTransactionCount === 0 ? 0 : ((rawTransactionCount - netTransferCount) / rawTransactionCount) * 100;

  return {
    transfers,
    rawTransactionCount,
    netTransferCount,
    totalVolumeMicros,
    reductionPct,
    commitmentHash: commitmentHashFor(payments),
    forcedEarlySettlement,
  };
}
