import { ethers } from "ethers";
import { AgentWallet } from "../../sdk/src/index";
import { getChainContext, withOperatorLock, nextNonce } from "./chain";
import { getDomain } from "./domain";

/**
 * DEMO-ONLY: holds private keys server-side so the dashboard's "run
 * simulation" button can generate a realistic day of agent-to-agent traffic
 * with one click. A real deployment never does this — every agent signs
 * with its own key, client-side, via the SDK's AgentWallet, and only ever
 * sends the *signed authorization* (never a private key) to a service or
 * this backend. See POST /api/pay for the real integration surface.
 */
export interface DemoAgent {
  role: "service" | "caller";
  signer: ethers.HDNodeWallet;
  wallet: AgentWallet;
  onboarded: boolean;
}

let pool: DemoAgent[] | null = null;

const CREDIT_LIMIT_USD = 50;
const COLLATERAL_USD = 50;

export async function getOrCreateDemoAgents(numServices: number, numCallers: number): Promise<DemoAgent[]> {
  if (pool && pool.length === numServices + numCallers) return pool;

  const ctx = getChainContext();
  const domain = getDomain();
  const total = numServices + numCallers;
  const agents: DemoAgent[] = [];

  for (let i = 0; i < total; i++) {
    const signer = ethers.Wallet.createRandom().connect(ctx.provider);
    const wallet = await AgentWallet.create(signer, {
      domain,
      creditLimitMicros: BigInt(CREDIT_LIMIT_USD * 1_000_000),
    });
    agents.push({ role: i < numServices ? "service" : "caller", signer, wallet, onboarded: false });
  }

  pool = agents;
  return pool;
}

/** Registers each demo agent on-chain, funds them with ETH (for gas on
 * their one deposit tx) and USDC (via the mock faucet), and has each agent
 * deposit its own collateral. Idempotent — safe to call every simulation
 * run since already-onboarded agents are skipped. */
export async function ensureOnboarded(agents: DemoAgent[]): Promise<void> {
  const ctx = getChainContext();
  const collateral = ethers.parseUnits(COLLATERAL_USD.toString(), 6);

  // The whole onboarding pass is one operator-locked unit of work: it mixes
  // operator-signed txs (register, ETH funding, faucet) with agent-signed
  // txs (approve, deposit), and must never interleave with another
  // concurrent onboarding/settlement pass touching the same operator wallet.
  await withOperatorLock(async () => {
    for (const agent of agents) {
      if (agent.onboarded) continue;

      const isRegistered: boolean = await ctx.registry.isRegistered(agent.signer.address);
      if (!isRegistered) {
        const nonce = await nextNonce();
        await (await ctx.registry.registerAgent(agent.signer.address, { nonce })).wait();
      }

      // Give the agent enough ETH to pay gas for its one on-chain deposit.
      const fundNonce = await nextNonce();
      await (
        await ctx.operator.sendTransaction({ to: agent.signer.address, value: ethers.parseEther("1"), nonce: fundNonce })
      ).wait();

      const faucetNonce = await nextNonce();
      await (await ctx.usdc.faucet(agent.signer.address, collateral, { nonce: faucetNonce })).wait();
      const usdcAsAgent = ctx.usdc.connect(agent.signer) as typeof ctx.usdc;
      const agentNonceStart = await ctx.provider.getTransactionCount(agent.signer.address, "pending");
      await (await usdcAsAgent.approve(ctx.addresses.SettlementClearinghouse, collateral, { nonce: agentNonceStart })).wait();

      const clearinghouseAsAgent = ctx.clearinghouse.connect(agent.signer) as typeof ctx.clearinghouse;
      await (await clearinghouseAsAgent.deposit(collateral, { nonce: agentNonceStart + 1 })).wait();

      agent.onboarded = true;
    }
  });
}

export function resetDemoAgents() {
  pool = null;
}
