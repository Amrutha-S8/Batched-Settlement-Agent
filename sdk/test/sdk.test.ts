import { expect } from "chai";
import { Wallet } from "ethers";
import { buildDomain } from "../src/eip712";
import { signAuthorization, verifyAuthorization } from "../src/sign";
import { AgentWallet } from "../src/AgentWallet";
import { PaymentAuthorization } from "../src/types";

const CHAIN_ID = 31337;
const CLEARINGHOUSE = "0x1111111111111111111111111111111111111111";
const domain = buildDomain(CHAIN_ID, CLEARINGHOUSE);

describe("sign/verify roundtrip", () => {
  it("verifies a correctly signed authorization", async () => {
    const payer = Wallet.createRandom();
    const auth: PaymentAuthorization = {
      from: payer.address,
      to: "0x2222222222222222222222222222222222222222",
      amountMicros: "3000", // $0.003
      serviceId: "weather-api-call",
      nonce: "n1",
      expiry: Math.floor(Date.now() / 1000) + 300,
    };

    const signed = await signAuthorization(payer, domain, auth);
    const result = verifyAuthorization(domain, signed);

    expect(result.valid).to.equal(true);
    expect(result.recoveredSigner?.toLowerCase()).to.equal(payer.address.toLowerCase());
  });

  it("rejects a tampered amount even with a valid-looking signature", async () => {
    const payer = Wallet.createRandom();
    const auth: PaymentAuthorization = {
      from: payer.address,
      to: "0x2222222222222222222222222222222222222222",
      amountMicros: "1000",
      serviceId: "svc",
      nonce: "n2",
      expiry: Math.floor(Date.now() / 1000) + 300,
    };
    const signed = await signAuthorization(payer, domain, auth);

    // Attacker/buggy client tries to claim a bigger amount was authorized.
    const tampered = { ...signed, authorization: { ...auth, amountMicros: "999000" } };
    const result = verifyAuthorization(domain, tampered);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal("signer_mismatch");
  });

  it("rejects an expired authorization", async () => {
    const payer = Wallet.createRandom();
    const auth: PaymentAuthorization = {
      from: payer.address,
      to: "0x2222222222222222222222222222222222222222",
      amountMicros: "1000",
      serviceId: "svc",
      nonce: "n3",
      expiry: Math.floor(Date.now() / 1000) - 10, // already expired
    };
    const signed = await signAuthorization(payer, domain, auth);
    const result = verifyAuthorization(domain, signed);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal("expired");
  });

  it("rejects a signature from the wrong domain (wrong contract/chain)", async () => {
    const payer = Wallet.createRandom();
    const auth: PaymentAuthorization = {
      from: payer.address,
      to: "0x2222222222222222222222222222222222222222",
      amountMicros: "1000",
      serviceId: "svc",
      nonce: "n4",
      expiry: Math.floor(Date.now() / 1000) + 300,
    };
    const signed = await signAuthorization(payer, domain, auth);

    const wrongDomain = buildDomain(CHAIN_ID, "0x9999999999999999999999999999999999999999");
    const result = verifyAuthorization(wrongDomain, signed);

    expect(result.valid).to.equal(false);
    expect(result.reason).to.equal("signer_mismatch");
  });
});

describe("AgentWallet", () => {
  it("issues instant off-chain authorizations without touching the chain", async () => {
    const signer = Wallet.createRandom();
    const wallet = await AgentWallet.create(signer, {
      domain,
      creditLimitMicros: 500_000n, // $0.50
    });

    const signed = await wallet.pay("0x2222222222222222222222222222222222222222", 3_000n, "weather-api");
    expect(signed.authorization.from).to.equal(signer.address);
    expect(wallet.outstandingBalanceMicros).to.equal(3_000n);

    const verification = verifyAuthorization(domain, signed);
    expect(verification.valid).to.equal(true);
  });

  it("refuses to authorize a payment that would exceed the local credit limit", async () => {
    const signer = Wallet.createRandom();
    const wallet = await AgentWallet.create(signer, {
      domain,
      creditLimitMicros: 1_000n,
    });

    await wallet.pay("0x2222222222222222222222222222222222222222", 800n, "svc");
    await expect(wallet.pay("0x2222222222222222222222222222222222222222", 500n, "svc")).to.be.rejectedWith(
      /exceed credit limit/
    );
  });

  it("frees up credit after a settlement clears the outstanding tab", async () => {
    const signer = Wallet.createRandom();
    const wallet = await AgentWallet.create(signer, {
      domain,
      creditLimitMicros: 1_000n,
    });

    await wallet.pay("0x2222222222222222222222222222222222222222", 1_000n, "svc");
    expect(wallet.availableCreditMicros).to.equal(0n);

    wallet.onSettled(1_000n);
    expect(wallet.availableCreditMicros).to.equal(1_000n);

    // Should be able to pay again now that the tab is cleared.
    const signed = await wallet.pay("0x2222222222222222222222222222222222222222", 1_000n, "svc");
    expect(signed.authorization.amountMicros).to.equal("1000");
  });

  it("generates unique nonces across many rapid authorizations", async () => {
    const signer = Wallet.createRandom();
    const wallet = await AgentWallet.create(signer, {
      domain,
      creditLimitMicros: 1_000_000n,
    });

    const nonces = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const signed = await wallet.pay("0x2222222222222222222222222222222222222222", 1n, "svc");
      nonces.add(signed.authorization.nonce);
    }
    expect(nonces.size).to.equal(50);
  });
});
