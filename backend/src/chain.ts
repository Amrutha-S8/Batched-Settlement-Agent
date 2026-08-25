import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..");

function loadArtifactAbi(contractFile: string, contractName: string) {
  const artifactPath = path.join(ROOT, "artifacts", "contracts", `${contractFile}.sol`, `${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return artifact.abi;
}

export interface ChainConfig {
  rpcUrl: string;
  operatorPrivateKey: string;
  network: string;
}

function loadConfig(): ChainConfig {
  return {
    rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8545",
    // Hardhat's well-known default account #0 private key — fine for local
    // dev only. Set OPERATOR_PRIVATE_KEY in .env for anything real.
    operatorPrivateKey:
      process.env.OPERATOR_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    network: process.env.NETWORK || "localhost",
  };
}

function loadDeployedAddresses(networkName: string) {
  const addrPath = path.join(ROOT, `deployed-addresses.${networkName}.json`);
  if (!fs.existsSync(addrPath)) {
    throw new Error(
      `No deployed-addresses.${networkName}.json found. Run: npx hardhat run scripts/deploy.ts --network ${networkName}`
    );
  }
  return JSON.parse(fs.readFileSync(addrPath, "utf8"));
}

export interface ChainContext {
  provider: ethers.JsonRpcProvider;
  operator: ethers.Wallet;
  addresses: Record<string, string>;
  chainId: number;
  usdc: ethers.Contract;
  registry: ethers.Contract;
  insurancePool: ethers.Contract;
  clearinghouse: ethers.Contract;
}

let cached: ChainContext | null = null;

export function getChainContext(): ChainContext {
  if (cached) return cached;

  const config = loadConfig();
  const deployed = loadDeployedAddresses(config.network);

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const operator = new ethers.Wallet(config.operatorPrivateKey, provider);

  const usdc = new ethers.Contract(deployed.contracts.MockUSDC, loadArtifactAbi("MockUSDC", "MockUSDC"), operator);
  const registry = new ethers.Contract(
    deployed.contracts.AgentRegistry,
    loadArtifactAbi("AgentRegistry", "AgentRegistry"),
    operator
  );
  const insurancePool = new ethers.Contract(
    deployed.contracts.InsurancePool,
    loadArtifactAbi("InsurancePool", "InsurancePool"),
    operator
  );
  const clearinghouse = new ethers.Contract(
    deployed.contracts.SettlementClearinghouse,
    loadArtifactAbi("SettlementClearinghouse", "SettlementClearinghouse"),
    operator
  );

  cached = {
    provider,
    operator,
    addresses: deployed.contracts,
    chainId: deployed.chainId,
    usdc,
    registry,
    insurancePool,
    clearinghouse,
  };
  return cached;
}

// ---------------------------------------------------------------------
// A single shared operator wallet signs every server-initiated transaction
// (agent registration, demo ETH/USDC funding, batch settlement). ethers
// assigns nonces per-call rather than queueing them, so two overlapping
// requests that both send operator-signed transactions WILL race and one
// will fail with "nonce too low". This tiny mutex serializes every chunk of
// work that touches the operator wallet so request handlers can stay
// simple `await`-based code without worrying about that race.
// ---------------------------------------------------------------------
let operatorQueue: Promise<unknown> = Promise.resolve();

export function withOperatorLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = operatorQueue.then(fn, fn);
  // Swallow rejections in the chain itself so one failed call doesn't
  // permanently jam the queue for subsequent callers — each caller still
  // gets its own rejection via `result`.
  operatorQueue = result.catch(() => undefined);
  return result;
}

// ---------------------------------------------------------------------
// Explicit nonce tracking for the operator wallet.
//
// Relying on `getTransactionCount(address, "pending")` per-call turned out
// to be unreliable against a local Hardhat node under back-to-back
// automined transactions — occasionally the "pending" count doesn't yet
// reflect a transaction that was JUST mined and awaited via tx.wait(),
// producing sporadic "nonce too low" errors even with calls fully
// serialized by withOperatorLock. Tracking the next nonce ourselves (seeded
// once from the chain, then incremented locally for every subsequent send)
// sidesteps that race entirely and is the standard pattern for any backend
// that sends transactions from a single hot wallet.
// ---------------------------------------------------------------------
let nextOperatorNonce: number | null = null;

/** Must only be called from within a withOperatorLock callback. */
export async function nextNonce(): Promise<number> {
  const ctx = getChainContext();
  if (nextOperatorNonce === null) {
    nextOperatorNonce = await ctx.provider.getTransactionCount(ctx.operator.address, "pending");
  }
  const n = nextOperatorNonce;
  nextOperatorNonce += 1;
  return n;
}
