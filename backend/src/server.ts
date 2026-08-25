import express, { Request, Response } from "express";
import cors from "cors";
import { ethers } from "ethers";
import { verifyAuthorization, SignedPaymentAuthorization } from "../../sdk/src/index";
import { runNettingCycle, MicroPayment } from "../../netting-engine/src/index";
import { ledger } from "./ledger";
import { getChainContext, withOperatorLock, nextNonce } from "./chain";
import { getDomain } from "./domain";
import { getOrCreateDemoAgents, ensureOnboarded } from "./demoAgents";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

// A small in-memory cache of on-chain credit limits so /api/pay doesn't hit
// the chain on every single micro-payment (that would defeat the entire
// point). Refreshed lazily; a production system would push updates via
// events instead of polling.
const creditLimitCache = new Map<string, bigint>();

async function creditLimitFor(agent: string): Promise<bigint> {
  if (creditLimitCache.has(agent)) return creditLimitCache.get(agent)!;
  const ctx = getChainContext();
  const limit: bigint = await ctx.registry.creditLimitOf(agent);
  creditLimitCache.set(agent, limit);
  return limit;
}

// ---------------------------------------------------------------------
// POST /api/pay — the real integration surface. An agent's own SDK
// (AgentWallet.pay) signs a PaymentAuthorization client-side and posts the
// result here. This never touches the chain: verify signature, check
// replay, check the agent's running tab against their on-chain credit
// limit, accept. This is what makes "pay per API call" viable at
// sub-cent prices.
// ---------------------------------------------------------------------
app.post("/api/pay", async (req: Request, res: Response) => {
  const signed = req.body as SignedPaymentAuthorization;
  if (!signed?.authorization || !signed?.signature) {
    return res.status(400).json({ accepted: false, reason: "malformed request" });
  }

  const domain = getDomain();
  const verification = verifyAuthorization(domain, signed);
  if (!verification.valid) {
    return res.status(402).json({ accepted: false, reason: verification.reason });
  }

  const { authorization } = signed;
  if (ledger.hasSeenNonce(authorization.nonce)) {
    return res.status(409).json({ accepted: false, reason: "nonce already used (replay)" });
  }

  const amountMicros = BigInt(authorization.amountMicros);
  const limit = await creditLimitFor(authorization.from);
  const projectedOutstanding = ledger.outstandingFor(authorization.from) + amountMicros;
  if (projectedOutstanding > limit) {
    return res.status(402).json({
      accepted: false,
      reason: "would exceed on-chain credit limit",
      limitMicros: limit.toString(),
      projectedOutstandingMicros: projectedOutstanding.toString(),
    });
  }

  const payment: MicroPayment = {
    from: authorization.from,
    to: authorization.to,
    amountMicros,
    serviceId: authorization.serviceId,
    nonce: authorization.nonce,
    timestamp: Date.now(),
  };
  ledger.addPayment(payment);

  res.json({
    accepted: true,
    outstandingMicros: ledger.outstandingFor(authorization.from).toString(),
    availableCreditMicros: (limit - ledger.outstandingFor(authorization.from)).toString(),
  });
});

// ---------------------------------------------------------------------
// GET /api/stats — pending (unsettled) ledger state + cumulative on-chain
// settlement stats, for the dashboard.
// ---------------------------------------------------------------------
app.get("/api/stats", async (_req: Request, res: Response) => {
  const ctx = getChainContext();
  const [batchCount, totalRaw, totalNet, totalVolume, settlementRatioBps] = await Promise.all([
    ctx.clearinghouse.batchCount(),
    ctx.clearinghouse.totalRawMicropaymentsSettled(),
    ctx.clearinghouse.totalNetTransfersExecuted(),
    ctx.clearinghouse.totalVolumeSettled(),
    ctx.clearinghouse.settlementRatio(),
  ]);

  res.json({
    pending: ledger.stats(),
    settled: {
      batchCount: Number(batchCount),
      totalRawMicropaymentsSettled: totalRaw.toString(),
      totalNetTransfersExecuted: totalNet.toString(),
      totalVolumeSettledMicros: totalVolume.toString(),
      // settlementRatio() returns net/raw in bps; invert for an intuitive "% saved" figure.
      cumulativeReductionPct: totalRaw === 0n ? 0 : 100 - Number(settlementRatioBps) / 100,
    },
    addresses: ctx.addresses,
  });
});

// ---------------------------------------------------------------------
// POST /api/settle — run the netting engine over everything pending and
// submit the minimized batch on-chain in a single transaction.
// ---------------------------------------------------------------------
app.post("/api/settle", async (_req: Request, res: Response) => {
  const pending = ledger.getPending();
  if (pending.length === 0) {
    return res.status(400).json({ error: "nothing pending to settle" });
  }

  const ctx = getChainContext();
  const result = runNettingCycle(pending);

  const debtors = result.transfers.map((t) => t.from);
  const creditors = result.transfers.map((t) => t.to);
  const amounts = result.transfers.map((t) => t.amountMicros);

  const receipt = await withOperatorLock(async () => {
    const nonce = await nextNonce();
    const tx = await ctx.clearinghouse.settleBatch(
      debtors,
      creditors,
      amounts,
      result.rawTransactionCount,
      result.commitmentHash,
      { nonce }
    );
    return tx.wait();
  });

  ledger.clear();
  // Credit limits may have shifted (reputation moved); drop the cache so
  // the next /api/pay calls re-fetch fresh values.
  creditLimitCache.clear();

  // Carry forward any unresolved shortfalls (defaults the insurance pool
  // couldn't fully cover — see contracts/SettlementClearinghouse.sol's
  // UnresolvedShortfall event) as new obligations in the *next* netting
  // cycle, rather than letting them vanish. This is what makes the
  // contract's graceful-degradation behavior actually correct end to end:
  // the debtor still owes the money, it's just deferred, not forgiven.
  const carriedForward: { from: string; to: string; amountMicros: string }[] = [];
  for (const log of receipt!.logs) {
    let parsed;
    try {
      parsed = ctx.clearinghouse.interface.parseLog(log);
    } catch {
      continue; // not one of our events (e.g. an ERC20 Transfer from the fee/insurance calls)
    }
    if (parsed?.name === "UnresolvedShortfall") {
      const [, debtor, creditor, shortfallMicros] = parsed.args as unknown as [bigint, string, string, bigint];
      ledger.addPayment({
        from: debtor,
        to: creditor,
        amountMicros: shortfallMicros,
        serviceId: "carried-forward-shortfall",
        nonce: `carry-${receipt!.hash}-${debtor}-${creditor}`,
        timestamp: Date.now(),
      });
      carriedForward.push({ from: debtor, to: creditor, amountMicros: shortfallMicros.toString() });
    }
  }

  res.json({
    rawTransactionCount: result.rawTransactionCount,
    netTransferCount: result.netTransferCount,
    reductionPct: result.reductionPct,
    totalVolumeMicros: result.totalVolumeMicros.toString(),
    txHash: receipt!.hash,
    gasUsed: receipt!.gasUsed.toString(),
    commitmentHash: result.commitmentHash,
    transfers: result.transfers.map((t) => ({ from: t.from, to: t.to, amountMicros: t.amountMicros.toString() })),
    carriedForwardShortfalls: carriedForward,
  });
});

// ---------------------------------------------------------------------
// GET /api/agents — on-chain balance + reputation snapshot for whichever
// agents have transacted, for the dashboard's agent table.
// ---------------------------------------------------------------------
app.get("/api/agents", async (req: Request, res: Response) => {
  const ctx = getChainContext();
  const addressesParam = (req.query.addresses as string) ?? "";
  const addresses = addressesParam.split(",").filter(Boolean);

  const rows = await Promise.all(
    addresses.map(async (address) => {
      const [balance, tier, agentRecord] = await Promise.all([
        ctx.clearinghouse.balanceOf(address),
        ctx.registry.tierOf(address),
        ctx.registry.agents(address),
      ]);
      return {
        address,
        balanceUsd: ethers.formatUnits(balance, 6),
        tier: Number(tier),
        reputationScore: agentRecord[1].toString(),
        successfulSettlements: agentRecord[3].toString(),
        defaults: agentRecord[4].toString(),
      };
    })
  );

  res.json({ agents: rows });
});

// ---------------------------------------------------------------------
// GET /api/batches — full settlement history, most recent first. Powers
// the dashboard's Batch History tab so a reviewer can see every past
// settleBatch() call — not just the live/current cycle — with its
// raw-vs-net counts, volume, and commitment hash for audit purposes.
// ---------------------------------------------------------------------
app.get("/api/batches", async (_req: Request, res: Response) => {
  const ctx = getChainContext();
  const count = Number(await ctx.clearinghouse.batchCount());

  const batches = await Promise.all(
    Array.from({ length: count }, (_, i) => i).map(async (batchId) => {
      const record = await ctx.clearinghouse.getBatch(batchId);
      return {
        batchId,
        rawTransactionCount: record.rawTransactionCount.toString(),
        netTransferCount: record.netTransferCount.toString(),
        totalVolumeMicros: record.totalVolume.toString(),
        commitmentHash: record.commitmentHash,
        timestamp: Number(record.timestamp),
      };
    })
  );

  res.json({ batches: batches.reverse(), totalUnresolvedShortfallMicros: (await ctx.clearinghouse.totalUnresolvedShortfallMicros()).toString() });
});

// ---------------------------------------------------------------------
// GET /api/config — static-ish contract parameters (credit tiers, fee bps,
// insurance pool state) the dashboard needs for its Agents and Security
// tabs but that don't change often enough to justify their own polling.
// ---------------------------------------------------------------------
app.get("/api/config", async (_req: Request, res: Response) => {
  const ctx = getChainContext();
  const tierNames = ["UNREGISTERED", "NEW", "ESTABLISHED", "TRUSTED"] as const;
  const [feeBps, poolAssets, poolShares] = await Promise.all([
    ctx.clearinghouse.feeBps(),
    ctx.insurancePool.totalAssets(),
    ctx.insurancePool.totalShares(),
  ]);

  const tierLimits = await Promise.all(
    [1, 2, 3].map(async (t) => ({
      tier: tierNames[t],
      creditLimitUsd: ethers.formatUnits(await ctx.registry.tierCreditLimit(t), 6),
    }))
  );

  res.json({
    feeBps: Number(feeBps),
    insurancePool: {
      totalAssetsUsd: ethers.formatUnits(poolAssets, 6),
      totalShares: poolShares.toString(),
      pricePerShare: ethers.formatUnits(await ctx.insurancePool.pricePerShare(), 18),
    },
    tierLimits,
  });
});

// ---------------------------------------------------------------------
// POST /api/demo/run — one-click simulation for the dashboard: spins up
// (or reuses) a pool of demo agents, generates a day of x402-authorized
// traffic through the exact same signing path real agents use, and returns
// the resulting agent addresses + pending stats so the UI can then trigger
// /api/settle and watch the netting happen.
// ---------------------------------------------------------------------
app.post("/api/demo/run", async (req: Request, res: Response) => {
  const numServices = Number(req.body.numServices ?? 5);
  const numCallers = Number(req.body.numCallers ?? 14);
  const callsPerPair = Number(req.body.callsPerPair ?? 60);
  const priceUsd = Number(req.body.priceUsd ?? 0.002);

  const agents = await getOrCreateDemoAgents(numServices, numCallers);
  await ensureOnboarded(agents);

  const services = agents.filter((a) => a.role === "service");
  const callers = agents.filter((a) => a.role === "caller");
  const amountMicros = BigInt(Math.round(priceUsd * 1_000_000));

  let signed = 0;
  const start = Date.now();
  for (const caller of callers) {
    for (const service of services) {
      for (let i = 0; i < callsPerPair; i++) {
        const authorization = await caller.wallet.pay(
          service.signer.address,
          amountMicros,
          `svc-${service.signer.address.slice(0, 8)}`
        );
        const payment: MicroPayment = {
          from: authorization.authorization.from,
          to: authorization.authorization.to,
          amountMicros,
          serviceId: authorization.authorization.serviceId,
          nonce: authorization.authorization.nonce,
          timestamp: Date.now(),
        };
        // Bypass the credit-limit re-check here since we already trust our
        // own demo wallets' local accounting; a real client would call the
        // actual POST /api/pay endpoint instead of this in-process path.
        ledger.addPayment(payment);
        signed++;
      }
    }
  }
  const elapsedMs = Date.now() - start;

  res.json({
    signedCount: signed,
    elapsedMs,
    avgMsPerSignature: elapsedMs / signed,
    agentAddresses: agents.map((a) => a.signer.address),
    pending: ledger.stats(),
  });
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Batched Settlement Agent backend listening on http://localhost:${PORT}`);
});
