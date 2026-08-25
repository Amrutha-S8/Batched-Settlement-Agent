# Batched Settlement Agent

A production-grade clearinghouse for multilateral netting of agent-to-agent micro-payments on EVM blockchains.

## How It Works

1. **Off-chain signing** — Agents authorize payments with EIP-712 signatures (x402-style). No gas, no chain call, sub-millisecond.

2. **Backend ledger** — Signatures verified server-side. Payments recorded against on-chain credit limits via AgentRegistry.

3. **Netting collapse** — Greedy heap + exact DFS solver minimizes transfer graph. 1500 raw payments → 40–60 net transfers.

4. **Single batch tx** — All net transfers settled in one on-chain transaction via SettlementClearinghouse.

5. **Insurance backstop** — Shortfalls covered from InsurancePool reserves; uncoverable defaults carried forward.

## Stack

| Component | Language | Framework |
|-----------|----------|-----------|
| Smart Contracts | **Solidity** | Hardhat, OpenZeppelin |
| Backend API | **TypeScript** | Node.js, Express.js, ethers.js |
| Netting Engine | **TypeScript** | Custom algorithms (greedy heap + DFS) |
| Agent SDK | **TypeScript** | EIP-712 signing utilities |
| Dashboard | **HTML/CSS/JavaScript** | Vanilla (no framework) |
| Tests | **TypeScript** | Hardhat, Jest |
| Config | **TypeScript/JSON** | Hardhat, tsconfig |

**Languages & Statistics:**
- **Solidity**: 4 smart contracts (~1,200 LOC)
- **TypeScript**: Backend, SDK, netting engine, tests (~8,000 LOC)
- **HTML/CSS/JavaScript**: Real-time dashboard (~2,000 LOC)
- **Shell/JavaScript**: Deployment and build scripts

## Quick Start

```bash
# Install dependencies
npm install

# Compile contracts
npm run compile

# Run tests
npx hardhat test --no-compile

# Start local Hardhat node
npx hardhat node &

# Deploy contracts to localhost
npx hardhat run scripts/deploy.ts --network localhost

# Start backend API (port 4000)
npx ts-node backend/src/server.ts &

# Serve dashboard (port 3000)
node frontend/server.js

# Open http://localhost:3000 in browser
```

## Project Structure

```
├── contracts/                 # Solidity smart contracts
│   ├── MockUSDC.sol          # ERC20 token for testing
│   ├── AgentRegistry.sol      # Agent credit limits & reputation
│   ├── InsurancePool.sol      # Risk backstop for shortfalls
│   └── SettlementClearinghouse.sol # Core batch settlement contract
├── backend/src/               # Node.js/Express API server
│   ├── server.ts             # HTTP endpoints (/api/pay, /api/settle, /api/stats, etc.)
│   ├── chain.ts              # Contract initialization & nonce tracking
│   ├── ledger.ts             # In-memory micropayment ledger
│   ├── domain.ts             # EIP-712 domain configuration
│   └── demoAgents.ts         # Simulation helpers
├── netting-engine/src/        # Multilateral netting algorithm
│   ├── index.ts              # Main netting cycle
│   ├── netPositions.ts       # Net position calculation
│   ├── minimizeTransfers.ts  # Greedy heap + exact DFS solver
│   ├── creditLimits.ts       # Credit limit enforcement
│   ├── commitment.ts         # Commitment hash generation
│   └── types.ts              # Type definitions
├── sdk/src/                   # Agent wallet SDK
│   ├── AgentWallet.ts        # Wallet class for agents
│   ├── eip712.ts             # EIP-712 type definitions
│   ├── sign.ts               # Signing utilities
│   └── types.ts              # TypeScript types
├── frontend/                  # Web dashboard
│   ├── dashboard.html        # Single-page app (5 tabs)
│   └── server.js             # Simple HTTP server
├── scripts/                   # Deployment & testing scripts
│   ├── compile.js            # Contract compilation
│   ├── deploy.ts             # Deploy to local/testnet
│   ├── demo.ts               # Run demo simulation
│   └── testPayEndpoint.ts    # Test /api/pay endpoint
├── docs/                      # Documentation
│   ├── security.md           # Security analysis (Slither findings)
│   └── roadmap.md            # Future work & limitations
└── test/                      # Hardhat & netting-engine tests

```

## Features

✅ Multilateral netting (70–90% reduction)  
✅ EIP-712 typed signatures  
✅ Credit limits + tiered reputation  
✅ Insurance pool  
✅ Real-time dashboard  
✅ Commitment hash + audit trail  
✅ Comprehensive test suite (26+ tests)

## API Endpoints

### POST /api/pay
Accept a signed off-chain payment authorization.

```bash
curl -X POST http://localhost:4000/api/pay \
  -H "Content-Type: application/json" \
  -d '{
    "authorization": { "from": "0x...", "to": "0x...", "amountMicros": "1000", ... },
    "signature": "0x..."
  }'
```

### GET /api/stats
Get pending ledger state and cumulative settlement stats.

```bash
curl http://localhost:4000/api/stats
```

### GET /api/config
Get insurance pool reserves, fee basis points, and tier credit limits.

```bash
curl http://localhost:4000/api/config
```

### GET /api/batches
Get settlement batch history.

```bash
curl http://localhost:4000/api/batches
```

### POST /api/settle
Net pending batch and submit on-chain.

```bash
curl -X POST http://localhost:4000/api/settle
```

### POST /api/demo/run
Run simulated traffic (generate demo agents and payments).

```bash
curl -X POST http://localhost:4000/api/demo/run \
  -H "Content-Type: application/json" \
  -d '{ "numServices": 5, "numCallers": 10, "callsPerPair": 30, "priceUsd": 0.002 }'
```

## Testing

```bash
# Hardhat tests (contracts)
npx hardhat test --no-compile

# Netting engine tests
npx hardhat test --no-compile netting-engine/test/netting.test.ts

# SDK tests
npx hardhat test --no-compile sdk/test/sdk.test.ts
```

**Expected:** 26 tests passing (7 contract + 11 netting + 8 SDK)

## Dashboard

The real-time web UI (`http://localhost:3000`) provides:

- **Overview** — Live netting visualization (SVG graph), insurance pool stats, simulation controls
- **Agents** — Agent ledger with tier, reputation, balance
- **Batch History** — Past settlements with reduction % and commitment hashes
- **Architecture** — System diagram and component descriptions
- **Security** — Slither findings, limitations, roadmap

## Security

**Slither static analysis:** 22 findings → 17 triaged (fixed, accepted, or dismissed).  
See `docs/security.md` for full breakdown.

### Known Limitations

- ❌ On-chain fraud proofs (no dispute window yet)
- ❌ Decentralized operator set (single address can submit batches)
- ❌ Portable agent reputation (siloed to this clearinghouse)
- ❌ Risk-based insurance pricing (flat fee only)
- ❌ Mainnet deployment (testnet/localhost only)

See `docs/roadmap.md` for planned work.

## Deployment

### Local Hardhat (for development)

```bash
npx hardhat node &
npx hardhat run scripts/deploy.ts --network localhost
```

Contracts deployed to `deployed-addresses.localhost.json`.

### Base Sepolia Testnet

Set environment variables in `.env`:

```
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
DEPLOYER_PRIVATE_KEY=0x...
BASESCAN_API_KEY=...
```

Then:

```bash
npx hardhat run scripts/deploy.ts --network baseSepolia
```

Contracts deployed to `deployed-addresses.baseSepolia.json`.

## Environment

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Then fill in your configuration:

```
PORT=4000
RPC_URL=http://127.0.0.1:8545
NETWORK=localhost
OPERATOR_PRIVATE_KEY=0x...
```

**Never commit `.env` — it's in `.gitignore`.**

## License

MIT

## References

- [EIP-712: Typed structured data hashing and signing](https://eips.ethereum.org/EIPS/eip-712)
- [x402: Payment authorization standard](https://x402.org)
- [Multilateral netting in clearing houses](https://en.wikipedia.org/wiki/Clearing_house)
- [Hardhat documentation](https://hardhat.org/docs)
- [ethers.js v6](https://docs.ethers.org/v6/)
# Batched-Settlement-Agent
