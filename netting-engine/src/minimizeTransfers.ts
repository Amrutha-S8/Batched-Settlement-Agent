import { NetTransfer } from "./types";

/** Minimal binary max-heap keyed by absolute bigint magnitude. */
class MaxHeap<T> {
  private items: { key: bigint; value: T }[] = [];

  get size() {
    return this.items.length;
  }

  push(key: bigint, value: T) {
    this.items.push({ key, value });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].key >= this.items[i].key) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  pop(): { key: bigint; value: T } | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      while (true) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let largest = i;
        if (l < n && this.items[l].key > this.items[largest].key) largest = l;
        if (r < n && this.items[r].key > this.items[largest].key) largest = r;
        if (largest === i) break;
        [this.items[i], this.items[largest]] = [this.items[largest], this.items[i]];
        i = largest;
      }
    }
    return top;
  }
}

/**
 * Fast greedy heuristic for the multilateral settlement problem: given each
 * agent's net position, produce a small set of transfers that zeroes
 * everyone out. On every step, pay the single largest creditor from the
 * single largest debtor as much as possible. This is the standard "optimal
 * account balancing" greedy strategy — it is not guaranteed to hit the true
 * theoretical minimum (that variant is NP-hard, equivalent to a
 * set-partition problem), but it's O(n log n), scales to thousands of
 * agents, and in practice lands very close to optimal, and is *always* at
 * most (agents_with_nonzero_balance - 1) transfers — which is already the
 * ceiling that makes netting worth doing at all.
 */
export function greedyMinTransfers(netPositions: Map<string, bigint>): NetTransfer[] {
  const creditors = new MaxHeap<string>();
  const debtors = new MaxHeap<string>();

  for (const [agent, balance] of netPositions) {
    if (balance > 0n) creditors.push(balance, agent);
    else if (balance < 0n) debtors.push(-balance, agent);
  }

  const transfers: NetTransfer[] = [];

  let creditor = creditors.pop();
  let debtor = debtors.pop();

  while (creditor && debtor) {
    const settled = creditor.key < debtor.key ? creditor.key : debtor.key;
    transfers.push({ from: debtor.value, to: creditor.value, amountMicros: settled });

    const remainingCredit = creditor.key - settled;
    const remainingDebt = debtor.key - settled;

    // Push back whichever side wasn't fully exhausted, then always re-pop
    // fresh state for both sides. This guarantees we're always comparing
    // the true current largest creditor/debtor next iteration, even if
    // that's the same agent we just partially settled.
    if (remainingCredit > 0n) creditors.push(remainingCredit, creditor.value);
    if (remainingDebt > 0n) debtors.push(remainingDebt, debtor.value);

    creditor = creditors.pop();
    debtor = debtors.pop();
  }

  return transfers;
}

/**
 * Exact minimum-transaction solver via DFS + branch-and-bound. Guarantees
 * the true theoretical minimum number of transfers, at the cost of
 * exponential worst-case time — only safe for small graphs. Used as an
 * optional "optimal mode" (e.g. for a subgroup of high-value agents where
 * shaving one more transfer off is worth the extra compute), while the
 * greedy heuristic above handles cycle-wide netting at scale.
 */
export function exactMinTransfers(netPositions: Map<string, bigint>, maxAgents = 12): NetTransfer[] | null {
  const balances = Array.from(netPositions.entries())
    .filter(([, b]) => b !== 0n)
    .map(([agent, b]) => ({ agent, balance: b }));

  if (balances.length > maxAgents) return null; // caller should fall back to greedy

  let best: NetTransfer[] | null = null;

  function dfs(bals: { agent: string; balance: bigint }[], path: NetTransfer[]) {
    const idx = bals.findIndex((b) => b.balance !== 0n);
    if (idx === -1) {
      if (!best || path.length < best.length) best = [...path];
      return;
    }
    if (best && path.length >= best.length) return; // branch and bound

    for (let j = 0; j < bals.length; j++) {
      if (j === idx || bals[j].balance === 0n) continue;
      // Only pair opposite signs.
      if ((bals[idx].balance > 0n) === (bals[j].balance > 0n)) continue;

      const next = bals.map((b) => ({ ...b }));
      next[j].balance += next[idx].balance;
      const transfer: NetTransfer =
        next[idx].balance >= 0n
          ? { from: bals[j].agent, to: bals[idx].agent, amountMicros: bals[idx].balance > 0n ? bals[idx].balance : -bals[idx].balance }
          : { from: bals[idx].agent, to: bals[j].agent, amountMicros: bals[idx].balance > 0n ? bals[idx].balance : -bals[idx].balance };
      next[idx].balance = 0n;

      path.push(transfer);
      dfs(next, path);
      path.pop();
    }
  }

  dfs(balances, []);
  return best;
}
