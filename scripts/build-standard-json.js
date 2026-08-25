// Builds a solc standard-json *input* file with every import (including
// node_modules ones like @openzeppelin) already resolved to inline source
// content. This sidesteps two separate problems in this network-restricted
// environment: (1) Hardhat's own compiler downloader needs a blocked host,
// which scripts/compile.js already solves for normal builds, and (2)
// Slither/crytic-compile's default "solc" platform invokes external solc
// binaries with --combined-json, a flag the solcjs (npm-installed, WASM)
// binary doesn't support — only --standard-json. Producing this file lets
// us hand Slither a ready-made standard-json input and point it at solcjs
// via --compile-force-framework solc-json, which does speak --standard-json.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const OUT_PATH = path.join(ROOT, "slither-standard-input.json");

function resolveImport(importPath, fromDir) {
  const candidates = [
    path.resolve(fromDir, importPath),
    path.join(ROOT, "node_modules", importPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not resolve import: ${importPath} (from ${fromDir})`);
}

const sources = {};
const visited = new Set();

function addFile(absPath, keyName) {
  if (visited.has(absPath)) return;
  visited.add(absPath);

  const content = fs.readFileSync(absPath, "utf8");
  sources[keyName] = { content };

  const importRegex = /^\s*import\s+(?:[^"']*from\s+)?["']([^"']+)["']/gm;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    const fromDir = path.dirname(absPath);
    const resolvedAbs = resolveImport(importPath, fromDir);

    let resolvedKey;
    if (importPath.startsWith(".")) {
      resolvedKey = path.relative(ROOT, resolvedAbs).split(path.sep).join("/");
    } else {
      resolvedKey = importPath; // e.g. @openzeppelin/contracts/...
    }
    addFile(resolvedAbs, resolvedKey);
  }
}

const topLevelFiles = fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".sol"));
for (const file of topLevelFiles) {
  addFile(path.join(CONTRACTS_DIR, file), `contracts/${file}`);
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "storageLayout"],
        "": ["ast"],
      },
    },
  },
};

fs.writeFileSync(OUT_PATH, JSON.stringify(input));
console.log(`Wrote standard-json input (${topLevelFiles.length} top-level files, ${Object.keys(sources).length} total sources) to ${OUT_PATH}`);
