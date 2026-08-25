import { MicroPayment, NetPosition } from "./types";

/**
 * Collapses a raw list of micro-payments into each agent's single net
 * position for the cycle. This is the first stage of multilateral netting:
 * before we even think about which transfers to execute, we reduce an
 * arbitrarily large payment graph down to one number per agent.
 *
 * Example: if A paid B $0.003 a thousand times over the day for API calls,
 * and B separately paid A $0.001 fifty times for a data feed, this collapses
 * that into a single signed number for A and the mirrored number for B —
 * throwing away only the *order* of events, not any economically relevant
 * information (nobody's final balance depends on which of the 1,050
 * payments happened first).
 */
export function computeNetPositions(payments: MicroPayment[]): Map<string, bigint> {
  const net = new Map<string, bigint>();

  const bump = (agent: string, delta: bigint) => {
    net.set(agent, (net.get(agent) ?? 0n) + delta);
  };

  for (const p of payments) {
    if (p.amountMicros <= 0n) continue;
    bump(p.from, -p.amountMicros); // payer's position decreases (they owe more)
    bump(p.to, p.amountMicros); // payee's position increases (they're owed more)
  }

  // Drop agents that net out to exactly zero — they had activity but ended
  // the cycle owing nothing and being owed nothing, so they need zero
  // on-chain settlement.
  for (const [agent, balance] of net) {
    if (balance === 0n) net.delete(agent);
  }

  return net;
}

export function toNetPositionArray(net: Map<string, bigint>): NetPosition[] {
  return Array.from(net.entries()).map(([agent, netMicros]) => ({ agent, netMicros }));
}
