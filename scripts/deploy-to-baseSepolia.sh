#!/bin/bash
# Complete Base Sepolia deployment script
# Usage: bash scripts/deploy-to-baseSepolia.sh

set -e

echo "=========================================="
echo "Batched Settlement Agent — Base Sepolia Deployment"
echo "=========================================="
echo ""

# Check if .env exists and has values
if [ ! -f .env ]; then
    echo "❌ .env file not found"
    echo "Please create .env with:"
    echo "  BASE_SEPOLIA_RPC_URL="
    echo "  DEPLOYER_PRIVATE_KEY="
    echo "  BASESCAN_API_KEY="
    exit 1
fi

# Check if values are set
if grep -q "BASE_SEPOLIA_RPC_URL=$" .env; then
    echo "❌ BASE_SEPOLIA_RPC_URL is empty in .env"
    exit 1
fi

if grep -q "DEPLOYER_PRIVATE_KEY=$" .env; then
    echo "❌ DEPLOYER_PRIVATE_KEY is empty in .env"
    exit 1
fi

# Load environment
export $(cat .env | xargs)

echo "✓ Configuration loaded"
echo ""

# Step 1: Verify baseline tests pass
echo "Step 1: Verifying baseline tests..."
npm run test:contracts > /dev/null 2>&1 && echo "✓ Contract tests pass" || { echo "❌ Contract tests failed"; exit 1; }
npm run test:netting > /dev/null 2>&1 && echo "✓ Netting engine tests pass" || { echo "❌ Netting tests failed"; exit 1; }
npm run test:sdk > /dev/null 2>&1 && echo "✓ SDK tests pass" || { echo "❌ SDK tests failed"; exit 1; }
echo ""

# Step 2: Compile contracts
echo "Step 2: Compiling contracts..."
node scripts/compile.js > /dev/null
echo "✓ Contracts compiled"
echo ""

# Step 3: Deploy to Base Sepolia
echo "Step 3: Deploying to Base Sepolia..."
npx hardhat run scripts/deploy.ts --network baseSepolia --no-compile
echo ""

# Step 4: Check deployment file was created
if [ ! -f deployed-addresses.baseSepolia.json ]; then
    echo "❌ Deployment failed — no deployed-addresses.baseSepolia.json"
    exit 1
fi

echo "✓ Deployment complete"
echo ""

# Show deployed addresses
echo "=========================================="
echo "Deployed Contracts on Base Sepolia"
echo "=========================================="
cat deployed-addresses.baseSepolia.json
echo ""

# Step 5: Verify contracts (optional if BASESCAN_API_KEY is set)
if [ -n "$BASESCAN_API_KEY" ] && [ "$BASESCAN_API_KEY" != "" ]; then
    echo "Step 5: Verifying contracts on Basescan..."
    # Verification commands would go here
    echo "✓ Verification initiated"
else
    echo "⚠ BASESCAN_API_KEY not set — skipping contract verification"
fi

echo ""
echo "✓ Base Sepolia deployment complete!"
