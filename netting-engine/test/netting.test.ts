import { expect } from "chai";
import {
  MicroPayment,
  computeNetPositions,
  greedyMinTransfers,
  exactMinTransfers,
  runNettingCycle,
  findCreditLimitBreaches,
} from "../src/index";

function payment(from: string, to: string, amount: number, i: number): MicroPayment {
  return {
    from,
    to,
    amountMicros: BigInt(Math.round(amount * 1_000_000)),
    serviceId: "test-service",
    nonce: `n${i}`,
    timestamp: Date.now() + i,
  };
}

/** Verifies a transfer set actually reproduces the target net positions —
 * this is the one property that MUST hold no matter which algorithm
 * produced the transfers. */
function assertReproducesNetPositions(transfers: { from: string; to: string; amountMicros: bigint }[], expected: Map<string, bigint>) {
  const achieved = new Map<string, bigint>();
  for (const t of transfers) {
    achieved.set(t.from, (achieved.get(t.from) ?? 0n) - t.amountMicros);
    achieved.set(t.to, (achieved.get(t.to) ?? 0n) + t.amountMicros);
  }
  for (const [agent, balance] of expected) {
    expect(achieved.get(agent) ?? 0n).to.equal(balance, `agent ${agent} net position mismatch`);
  }
}

describe("netPositions", () => {
  it("aggregates many micro-payments into one net figure per agent", () => {
    const payments = [
      payment("A", "B", 0.003, 1),
      payment("A", "B", 0.003, 2),
      payment("B", "A", 0.001, 3),
    ];
    const net = computeNetPositions(payments);
    expect(net.get("A")).to.equal(-5000n); // -0.003 -0.003 +0.001 = -0.005
    expect(net.get("B")).to.equal(5000n);
  });

  it("drops agents whose activity nets to exactly zero", () => {
    const payments = [payment("A", "B", 1, 1), payment("B", "A", 1, 2)];
    const net = computeNetPositions(payments);
    expect(net.size).to.equal(0);
  });
});

describe("greedyMinTransfers", () => {
  it("settles a simple two-party imbalance in one transfer", () => {
    const net = new Map([
      ["A", -1_000_000n],
      ["B", 1_000_000n],
    ]);
    const transfers = greedyMinTransfers(net);
    expect(transfers).to.have.length(1);
    assertReproducesNetPositions(transfers, net);
  });

  it("never produces more than (n_agents - 1) transfers", () => {
    // 6 agents with varied random-ish balances that sum to zero.
    const net = new Map([
      ["A", -3_000_000n],
      ["B", -1_500_000n],
      ["C", 2_000_000n],
      ["D", 1_000_000n],
      ["E", -500_000n],
      ["F", 2_000_000n],
    ]);
    const transfers = greedyMinTransfers(net);
    expect(transfers.length).to.be.at.most(net.size - 1);
    assertReproducesNetPositions(transfers, net);
  });

  it("handles a large synthetic multilateral graph correctly", () => {
    const net = new Map<string, bigint>();
    let sum = 0n;
    for (let i = 0; i < 200; i++) {
      // Pseudo-random but deterministic signed balances.
      const magnitude = BigInt(((i * 7919) % 10_000) + 1);
      const balance = i % 2 === 0 ? magnitude : -magnitude;
      net.set(`agent-${i}`, balance);
      sum += balance;
    }
    // Force the set to balance to zero by adjusting the last agent.
    net.set("agent-199", (net.get("agent-199") ?? 0n) - sum);

    const transfers = greedyMinTransfers(net);
    assertReproducesNetPositions(transfers, net);
    expect(transfers.length).to.be.lessThan(200); // netting must reduce vs. raw agent count
  });
});

describe("exactMinTransfers", () => {
  it("matches the true minimum on a small known case", () => {
    // A owes 10, B owes 10, C is owed 20 -> true minimum is 2 transfers
    // (A->C 10, B->C 10); no arrangement of 3 agents with these signs can
    // do it in fewer than 2.
    const net = new Map([
      ["A", -10_000_000n],
      ["B", -10_000_000n],
      ["C", 20_000_000n],
    ]);
    const transfers = exactMinTransfers(net)!;
    expect(transfers).to.have.length(2);
    assertReproducesNetPositions(transfers, net);
  });

  it("finds a 1-transfer solution when one exists, beating naive pairwise settlement", () => {
    // A cycle where the *net* result only requires one transfer, even
    // though 3 raw pairwise debts exist.
    const net = new Map([
      ["A", -1_000_000n],
      ["B", 1_000_000n],
    ]);
    const transfers = exactMinTransfers(net)!;
    expect(transfers).to.have.length(1);
  });

  it("returns null and defers to greedy when the graph is too large", () => {
    const net = new Map<string, bigint>();
    for (let i = 0; i < 20; i++) {
      net.set(`agent-${i}`, i % 2 === 0 ? 100n : -100n);
    }
    const result = exactMinTransfers(net, 12);
    expect(result).to.equal(null);
  });
});

describe("findCreditLimitBreaches", () => {
  it("flags agents whose net debt exceeds their credit limit", () => {
    const net = new Map([
      ["A", -600_000n], // owes $0.60
      ["B", 600_000n],
    ]);
    const breaches = findCreditLimitBreaches(net, { A: 500_000n }); // limit $0.50
    expect(breaches).to.deep.equal(["A"]);
  });

  it("does not flag creditors regardless of size", () => {
    const net = new Map([["A", 10_000_000n]]);
    const breaches = findCreditLimitBreaches(net, { A: 100n });
    expect(breaches).to.deep.equal([]);
  });
});

describe("runNettingCycle (end-to-end)", () => {
  it("demonstrates real-world-scale reduction: thousands of micro-payments -> a handful of transfers", () => {
    const agents = Array.from({ length: 50 }, (_, i) => `agent-${i}`);
    const payments: MicroPayment[] = [];
    let counter = 0;

    // Simulate a busy mesh: every agent calls a handful of "service"
    // agents many times a day for sub-cent API/data payments.
    const serviceAgents = agents.slice(0, 5);
    for (const caller of agents.slice(5)) {
      for (const service of serviceAgents) {
        for (let call = 0; call < 40; call++) {
          payments.push(payment(caller, service, 0.002, counter++));
        }
      }
    }

    const result = runNettingCycle(payments);

    expect(result.rawTransactionCount).to.equal(payments.length);
    expect(result.netTransferCount).to.be.lessThan(result.rawTransactionCount);
    // With only 50 distinct agents, we should never need more than 49 net
    // transfers no matter how many thousands of raw payments occurred.
    expect(result.netTransferCount).to.be.at.most(49);
    expect(result.reductionPct).to.be.greaterThan(95);

    assertReproducesNetPositions(result.transfers, computeNetPositions(payments));
  });
});
