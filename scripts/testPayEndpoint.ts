import { Wallet, JsonRpcProvider, Contract } from "ethers";
import fetch from "node-fetch";
import * as fs from "fs";
import { AgentWallet, buildDomain } from "../sdk/src/index";

const BACKEND = "http://127.0.0.1:4000";

async function main() {
  const deployed = JSON.parse(fs.readFileSync("deployed-addresses.localhost.json", "utf8"));
  const provider = new JsonRpcProvider("http://127.0.0.1:8545");
  const operator = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
  const registryAbi = JSON.parse(
    fs.readFileSync("artifacts/contracts/AgentRegistry.sol/AgentRegistry.json", "utf8")
  ).abi;
  const registry = new Contract(deployed.contracts.AgentRegistry, registryAbi, operator);

  // A brand-new, never-before-seen agent (not part of the demo pool).
  const signer = Wallet.createRandom();
  const domain = buildDomain(31337, deployed.contracts.SettlementClearinghouse);
  const wallet = await AgentWallet.create(signer, { domain, creditLimitMicros: 1_000_000n });

  console.log(`Registering a fresh agent on-chain: ${signer.address}`);
  await (await registry.registerAgent(signer.address)).wait();

  console.log(`Testing /api/pay as a REGISTERED (but not yet collateralized) agent...`);
  const signed = await wallet.pay("0x000000000000000000000000000000000000bEEF", 3_000n, "weather-api-call");
  const res = await fetch(`${BACKEND}/api/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
  const body = await res.json();
  console.log(`Status ${res.status}:`, body);
  console.log("\nExpectation: NEW-tier registered agents get a $0.50 credit limit by default,");
  console.log("so a $0.003 payment should be ACCEPTED even before the agent has deposited any");
  console.log("on-chain collateral yet — the credit line is what makes 'pay first, settle later' work.");

  console.log("\nNow testing replay protection — resubmitting the exact same signed authorization...");
  const replay = await fetch(`${BACKEND}/api/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
  console.log(`Status ${replay.status}:`, await replay.json());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
