import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the full contract set to whatever network Hardhat is pointed at
 * (`--network localhost` against a running `npx hardhat node`, or
 * `--network baseSepolia` once you've filled in hardhat.config.ts with a
 * real RPC URL + funded deployer key) and wires the roles together:
 * clearinghouse <-> registry <-> insurance pool.
 *
 * Writes deployed-addresses.<network>.json so the backend and any scripts
 * can pick the addresses up without hardcoding them.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying to network "${network.name}" as ${deployer.address}...`);

  const USDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await USDC.deploy();
  await usdc.waitForDeployment();

  const Registry = await ethers.getContractFactory("AgentRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();

  const Pool = await ethers.getContractFactory("InsurancePool");
  const insurancePool = await Pool.deploy(await usdc.getAddress(), deployer.address);
  await insurancePool.waitForDeployment();

  const Clearinghouse = await ethers.getContractFactory("SettlementClearinghouse");
  const clearinghouse = await Clearinghouse.deploy(await usdc.getAddress(), await registry.getAddress(), deployer.address);
  await clearinghouse.waitForDeployment();

  console.log("Wiring roles...");
  await (await clearinghouse.setOperator(deployer.address)).wait();
  await (await clearinghouse.setInsurancePool(await insurancePool.getAddress())).wait();
  await (await insurancePool.setClearinghouse(await clearinghouse.getAddress())).wait();
  await (await registry.setOperator(await clearinghouse.getAddress(), true)).wait();

  // Seed the insurance pool with an initial float from the deployer acting
  // as the first staker. This isn't just demo convenience — with zero
  // reserves, settleBatch() reverts the *entire* batch the first time any
  // single agent nets out short (see docs/roadmap.md #7), so a floor stake
  // is operationally required before the system can accept any off-chain
  // credit at all.
  const initialStakeUsd = process.env.INITIAL_INSURANCE_STAKE_USD || "2000";
  const initialStake = ethers.parseUnits(initialStakeUsd, 6);
  if (initialStake > 0n) {
    console.log(`Seeding insurance pool with $${initialStakeUsd} initial stake from deployer...`);
    await (await usdc.approve(await insurancePool.getAddress(), initialStake)).wait();
    await (await insurancePool.deposit(initialStake)).wait();
  } else {
    console.log("INITIAL_INSURANCE_STAKE_USD=0 — deploying with an empty insurance pool (intentional for testing the uncovered-default path; see docs/roadmap.md #7).");
  }

  const net = await ethers.provider.getNetwork();
  const addresses = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      MockUSDC: await usdc.getAddress(),
      AgentRegistry: await registry.getAddress(),
      InsurancePool: await insurancePool.getAddress(),
      SettlementClearinghouse: await clearinghouse.getAddress(),
    },
  };

  const outPath = path.join(__dirname, "..", `deployed-addresses.${network.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));

  console.log("\nDeployment complete:");
  console.log(JSON.stringify(addresses, null, 2));
  console.log(`\nAddresses written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
