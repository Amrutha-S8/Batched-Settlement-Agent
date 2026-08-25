// Offline compile script.
//
// Hardhat's built-in `compile` task always tries to download the solc
// binary/wasm from binaries.soliditylang.org, which isn't reachable from
// this environment's network allowlist. We already have a fully-capable
// solc compiler available locally via the `solc` npm package (solc-js), so
// this script drives that directly and writes output into the exact
// artifact format Hardhat/ethers expect. Run `npx hardhat test --no-compile`
// (or `npm test`) after this so Hardhat skips its own compile step and just
// reads what we wrote here.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.resolve(__dirname, "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");

function findImports(importPath) {
  // Resolve node_modules-based imports (e.g. @openzeppelin/contracts/...)
  // and local relative imports the same way solc's default import
  // callback would.
  const candidates = [
    path.join(ROOT, "node_modules", importPath),
    path.join(CONTRACTS_DIR, importPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: `File not found: ${importPath}` };
}

function main() {
  const solFiles = fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".sol"));
  const sources = {};
  for (const file of solFiles) {
    sources[file] = { content: fs.readFileSync(path.join(CONTRACTS_DIR, file), "utf8") };
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.bytecode.linkReferences"],
        },
      },
    },
  };

  console.log(`Compiling ${solFiles.length} top-level source files with solc ${solc.version()}...`);
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  let hasError = false;
  if (output.errors) {
    for (const err of output.errors) {
      const isError = err.severity === "error";
      hasError = hasError || isError;
      console.log(`[solc ${err.severity}] ${err.formattedMessage}`);
    }
  }
  if (hasError) {
    console.error("Compilation failed.");
    process.exit(1);
  }

  let contractsWritten = 0;
  for (const [fileName, fileContracts] of Object.entries(output.contracts)) {
    const outDir = path.join(ARTIFACTS_DIR, "contracts", fileName);
    fs.mkdirSync(outDir, { recursive: true });

    for (const [contractName, contract] of Object.entries(fileContracts)) {
      const artifact = {
        _format: "hh-sol-artifact-1",
        contractName,
        sourceName: `contracts/${fileName}`,
        abi: contract.abi,
        bytecode: "0x" + contract.evm.bytecode.object,
        deployedBytecode: "0x" + contract.evm.deployedBytecode.object,
        linkReferences: contract.evm.bytecode.linkReferences || {},
        deployedLinkReferences: {},
      };
      fs.writeFileSync(path.join(outDir, `${contractName}.json`), JSON.stringify(artifact, null, 2));
      contractsWritten++;
    }
  }

  console.log(`Wrote ${contractsWritten} contract artifacts to ${path.relative(ROOT, ARTIFACTS_DIR)}/`);
}

main();
