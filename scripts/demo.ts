import { ethers } from "hardhat";
import { AgentWallet, buildDomain, verifyAuthorization, SignedPaymentAuthorization } from "../sdk/src/index";
import { runNettingCycle, MicroPayment } from "../netting-engine/src/index";

// Tunable simulation size. Kept within Hardhat's default 20 funded signers
// so the demo runs standalone with zero setup.
const NUM_SERVICE_AGENTS = 5;
const NUM_CALLER_AGENTS = 14;
const CALLS_PER_CALLER_PER_SERVICE = 60;
const PRICE_PER_CALL_USD = 0.002; // $0.002 — the kind of sub-cent price that can't settle individually on-chain

const usd6 = (n: number) => ethers.parseUnits(n.toFixed(6), 6);

async function main() {
  console.log("=".repeat(72));
  console.log("BATCHED SETTLEMENT AGENT — end-to-end demo");
  console.log("=".repeat(72));

  const signers = await ethers.getSigners();
  const [owner, ...pool] = signers;
  const serviceSigners = pool.slice(0, NUM_SERVICE_AGENTS);
  const callerSigners = pool.slice(NUM_SERVICE_AGENTS, NUM_SERVICE_AGENTS + NUM_CALLER_AGENTS);
  const allAgentSigners = [...serviceSigners, ...callerSigners];

  // ---------------------------------------------------------------
  // 1. Deploy contracts
  // ---------------------------------------------------------------
  const USDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await USDC.deploy();

  const Registry = await ethers.getContractFactory("AgentRegistry");
  const registry = await Registry.deploy(owner.address);

  const Pool = await ethers.getContractFactory("InsurancePool");
  const insurancePool = await Pool.deploy(await usdc.getAddress(), owner.address);

  const Clearinghouse = await ethers.getContractFactory("SettlementClearinghouse");
  const clearinghouse = await Clearinghouse.deploy(await usdc.getAddress(), await registry.getAddress(), owner.address);

  await clearinghouse.setOperator(owner.address);
  await clearinghouse.setInsurancePool(await insurancePool.getAddress());
  await insurancePool.setClearinghouse(await clearinghouse.getAddress());
  await registry.setOperator(await clearinghouse.getAddress(), true);

  console.log(`\nDeployed contracts:`);
  console.log(`  MockUSDC:                ${await usdc.getAddress()}`);
  console.log(`  AgentRegistry:           ${await registry.getAddress()}`);
  console.log(`  InsurancePool:           ${await insurancePool.getAddress()}`);
  console.log(`  SettlementClearinghouse: ${await clearinghouse.getAddress()}`);

  // ---------------------------------------------------------------
  // 2. Register agents and fund on-chain collateral
  // ---------------------------------------------------------------
  const collateralPerAgent = usd6(50);
  for (const signer of allAgentSigners) {
    await registry.registerAgent(signer.address);
    await usdc.faucet(signer.address, collateralPerAgent);
    await (usdc.connect(signer) as typeof usdc).approve(await clearinghouse.getAddress(), collateralPerAgent);
    await (clearinghouse.connect(signer) as typeof clearinghouse).deposit(collateralPerAgent);
  }
  console.log(`\nRegistered ${allAgentSigners.length} agents, each deposited $${ethers.formatUnits(collateralPerAgent, 6)} collateral.`);

  // ---------------------------------------------------------------
  // 3. Simulate a busy day of x402-authorized micro-payments, fully off-chain
  // ---------------------------------------------------------------
  const network = await ethers.provider.getNetwork();
  const domain = buildDomain(Number(network.chainId), await clearinghouse.getAddress());

  const callerWallets = new Map<string, AgentWallet>();
  for (const signer of callerSigners) {
    const wallet = await AgentWallet.create(signer, {
      domain,
      creditLimitMicros: usd6(50), // demo-scale local ceiling; mirrors on-chain tier limit
    });
    callerWallets.set(signer.address, wallet);
  }

  console.log(`\nSimulating micro-payments: ${NUM_CALLER_AGENTS} callers x ${NUM_SERVICE_AGENTS} services x ${CALLS_PER_CALLER_PER_SERVICE} calls each...`);

  const signedAuthorizations: SignedPaymentAuthorization[] = [];
  let signCounter = 0;
  const signStart = Date.now();

  for (const callerSigner of callerSigners) {
    const wallet = callerWallets.get(callerSigner.address)!;
    for (const serviceSigner of serviceSigners) {
      for (let call = 0; call < CALLS_PER_CALLER_PER_SERVICE; call++) {
        const signed = await wallet.pay(serviceSigner.address, BigInt(Math.round(PRICE_PER_CALL_USD * 1_000_000)), `service-${serviceSigner.address.slice(0, 8)}`);
        signedAuthorizations.push(signed);
        signCounter++;
      }
    }
  }
  const signElapsedMs = Date.now() - signStart;

  console.log(`  Signed ${signCounter} x402 authorizations in ${signElapsedMs}ms (${(signElapsedMs / signCounter).toFixed(2)}ms avg) — no chain interaction.`);

  // ---------------------------------------------------------------
  // 4. Simulate each service instantly verifying its incoming payment
  //    (this is the step that makes "pay per API call" viable at all)
  // ---------------------------------------------------------------
  const verifyStart = Date.now();
  let verifiedOk = 0;
  for (const signed of signedAuthorizations) {
    const result = verifyAuthorization(domain, signed);
    if (result.valid) verifiedOk++;
  }
  const verifyElapsedMs = Date.now() - verifyStart;
  console.log(`  Verified ${verifiedOk}/${signedAuthorizations.length} authorizations off-chain in ${verifyElapsedMs}ms (${(verifyElapsedMs / signedAuthorizations.length).toFixed(3)}ms avg).`);

  // ---------------------------------------------------------------
  // 5. Net the whole day down to the minimum settlement set
  // ---------------------------------------------------------------
  const microPayments: MicroPayment[] = signedAuthorizations.map((s, i) => ({
    from: s.authorization.from,
    to: s.authorization.to,
    amountMicros: BigInt(s.authorization.amountMicros),
    serviceId: s.authorization.serviceId,
    nonce: s.authorization.nonce,
    timestamp: Date.now() + i,
  }));

  const nettingResult = runNettingCycle(microPayments);

  console.log(`\nNetting result:`);
  console.log(`  Raw off-chain micro-payments:  ${nettingResult.rawTransactionCount}`);
  console.log(`  Net on-chain transfers needed: ${nettingResult.netTransferCount}`);
  console.log(`  Reduction:                     ${nettingResult.reductionPct.toFixed(2)}%`);
  console.log(`  Total volume settled:          $${ethers.formatUnits(nettingResult.totalVolumeMicros, 6)}`);

  // ---------------------------------------------------------------
  // 6. Submit the minimized batch on-chain in a single transaction
  // ---------------------------------------------------------------
  const debtors = nettingResult.transfers.map((t) => t.from);
  const creditors = nettingResult.transfers.map((t) => t.to);
  const amounts = nettingResult.transfers.map((t) => t.amountMicros);

  const tx = await clearinghouse.settleBatch(debtors, creditors, amounts, nettingResult.rawTransactionCount, nettingResult.commitmentHash);
  const receipt = await tx.wait();

  console.log(`\nOn-chain settlement:`);
  console.log(`  settleBatch() executed in tx ${receipt!.hash}`);
  console.log(`  Gas used for the ENTIRE day's settlement: ${receipt!.gasUsed.toString()}`);

  // Rough illustrative comparison: what would it have cost to settle every
  // raw micro-payment individually as its own ERC20 transfer? We measure
  // one simple transfer's real gas cost on this same chain rather than
  // assuming a number.
  const sampleTransferTx = await (usdc.connect(owner) as typeof usdc).transfer(callerSigners[0].address, 1n);
  const sampleReceipt = await sampleTransferTx.wait();
  const perTransferGas = sampleReceipt!.gasUsed;
  const naiveGasEstimate = perTransferGas * BigInt(nettingResult.rawTransactionCount);

  console.log(`  Reference: a single plain ERC20 transfer costs ~${perTransferGas.toString()} gas on this chain.`);
  console.log(`  Naive per-payment settlement would have cost ~${naiveGasEstimate.toString()} gas (${nettingResult.rawTransactionCount} transfers).`);
  console.log(`  Netted settlement cost ${receipt!.gasUsed.toString()} gas -> ~${(Number((naiveGasEstimate - receipt!.gasUsed) * 10000n / naiveGasEstimate) / 100).toFixed(2)}% gas savings.`);

  console.log(`\nFinal on-chain balances (sample):`);
  for (const signer of [...serviceSigners.slice(0, 2), ...callerSigners.slice(0, 2)]) {
    const bal = await clearinghouse.balanceOf(signer.address);
    console.log(`  ${signer.address}: $${ethers.formatUnits(bal, 6)}`);
  }

  console.log("\n" + "=".repeat(72));
  console.log("Demo complete.");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
