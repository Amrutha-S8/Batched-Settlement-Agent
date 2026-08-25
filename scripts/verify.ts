import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Verify deployed contracts on Basescan.
 * Usage: npx hardhat run scripts/verify.ts --network baseSepolia --no-compile
 */

async function main() {
  const network = process.env.HARDHAT_NETWORK || "baseSepolia";
  const addrPath = path.join(__dirname, "..", `deployed-addresses.${network}.json`);

  if (!fs.existsSync(addrPath)) {
    throw new Error(
      `No deployed-addresses.${network}.json found. Run deployment first: npx hardhat run scripts/deploy.ts --network ${network} --no-compile`
    );
  }

  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  console.log(`Verifying contracts on ${network}...`);
  console.log("");

  const contracts = [
    { name: "MockUSDC", address: addresses.contracts.MockUSDC, args: [] },
    { name: "AgentRegistry", address: addresses.contracts.AgentRegistry, args: [addresses.deployer] },
    { name: "InsurancePool", address: addresses.contracts.InsurancePool, args: [addresses.contracts.MockUSDC, addresses.deployer] },
    {
      name: "SettlementClearinghouse",
      address: addresses.contracts.SettlementClearinghouse,
      args: [addresses.contracts.MockUSDC, addresses.contracts.AgentRegistry, addresses.deployer],
    },
  ];

  for (const contract of contracts) {
    console.log(`Verifying ${contract.name} at ${contract.address}...`);

    const argsString = contract.args.length > 0 ? ` --constructor-args-params '${JSON.stringify(contract.args)}'` : "";

    try {
      execSync(
        `npx hardhat verify --network ${network}${argsString} ${contract.address} contracts/${contract.name}.sol:${contract.name}`,
        { stdio: "inherit" }
      );
      console.log(`✓ ${contract.name} verified\n`);
    } catch (error) {
      console.log(`⚠ ${contract.name} verification failed (may already be verified)\n`);
    }
  }

  console.log("Verification complete!");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
