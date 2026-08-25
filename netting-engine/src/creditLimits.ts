import { CreditLimits } from "./types";

/**
 * Agents are allowed to run an off-chain tab up to their reputation-tiered
 * credit limit (see AgentRegistry.sol) between settlements. If a single
 * agent's *net debtor* position exceeds their limit mid-cycle, the netting
 * engine shouldn't wait for the scheduled batch — it should force an
 * out-of-band settlement for just that agent (or refuse further instant
 * authorizations for them) so counterparties aren't left holding
 * unenforceable off-chain credit.
 *
 * This is what makes instant off-chain "pay now" safe: every authorization
 * is checked against a bounded, reputation-scaled limit, not an unlimited
 * IOU.
 */
export function findCreditLimitBreaches(netPositions: Map<string, bigint>, limits: CreditLimits): string[] {
  const breached: string[] = [];
  for (const [agent, balance] of netPositions) {
    if (balance >= 0n) continue; // only debtors can breach a credit limit
    const owed = -balance;
    const limit = limits[agent] ?? 0n;
    if (owed > limit) breached.push(agent);
  }
  return breached;
}
