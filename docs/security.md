# Security — static analysis findings and how they were handled

This isn't a substitute for a real audit. It's the minimum any smart
contract should get before anyone treats it as more than a prototype: a
static analysis pass, every finding read and triaged individually, and a
written record of *why* each one was fixed, accepted, or dismissed — not
just a clean-looking report.

## Tooling

- [Slither](https://github.com/crytic/slither) v0.11.6 (Trail of Bits)
- solc 0.8.24 (the same compiler version the contracts are written against)

## Reproduce it yourself

```bash
pip install slither-analyzer --break-system-packages
# Slither needs a solc binary on PATH matching the pragma version. If your
# environment can reach binaries.soliditylang.org, `solc-select install
# 0.8.24 && solc-select use 0.8.24` is the normal path. This repo was built
# in a network-restricted sandbox where that domain was blocked, so the
# binary was pulled from GitHub releases instead (also official):
curl -sL -o solc "https://github.com/ethereum/solidity/releases/download/v0.8.24/solc-static-linux"
chmod +x solc && sudo mv solc /usr/local/bin/solc

slither contracts/ --solc-remaps "@openzeppelin=node_modules/@openzeppelin" --filter-paths "node_modules"
```

## Findings — before and after

First pass on the original contracts: **22 findings** in our own code
(OpenZeppelin's own dependency noise filtered out via `--filter-paths`).
After fixes: **17 findings**, all consciously accepted below.

| Category | Count | Disposition |
|---|---|---|
| `missing-zero-check` | 3 | **Fixed** |
| `uninitialized-local` | 2 | **Fixed** |
| `reentrancy-no-eth` / `reentrancy-benign` | 2 | Accepted — mitigated by `ReentrancyGuard` |
| `calls-loop` | 3 | Accepted — operator-only, bounded by netting output |
| `costly-loop` | 2 | Accepted — informational, same root cause as above |
| `naming-convention` | 2 | Dismissed — deliberate, not a bug |
| `timestamp` | 2 | Dismissed — false positive |

### Fixed: missing zero-address checks (`missing-zero-check`)

`SettlementClearinghouse.setOperator/setRegistry/setInsurancePool` and
`InsurancePool.setClearinghouse` took the new address with no validation.
Setting any of these to `address(0)` by mistake (a fat-fingered deploy
script, a copy-paste error) would have silently broken the contract —
`settleBatch` would revert on every call once `operator` or `registry` was
zeroed, with no clear error pointing at the cause. Cheap, unambiguous fix:
a `ZeroAddress()` custom error on all four setters, each covered by a new
test (`rejects zero-address for every privileged admin setter`).

### Fixed: uninitialized locals (`uninitialized-local`)

`batchVolume` and `feeAccrued` in `settleBatch` were declared without an
explicit `= 0`. Solidity always zero-initializes local value types, so this
was never a correctness bug — but leaving it implicit is exactly the kind
of ambiguity that's cheap to remove, so both now have explicit initializers.

### Accepted: reentrancy patterns (`reentrancy-no-eth`, `reentrancy-benign`)

Slither flags `settleBatch` writing to `balanceOf` and the batch-stats
counters *after* external calls to `registry` and `insurancePool`. That's
the classic checks-effects-interactions violation shape — but
`SettlementClearinghouse` and `InsurancePool` both inherit OpenZeppelin's
`ReentrancyGuard`, which uses a single `_status` lock shared across *every*
`nonReentrant`-modified function in the contract, not a per-function lock.
`deposit()` and `withdraw()` are both `nonReentrant`, so even if `registry`
or `insurancePool` were malicious and tried to reenter mid-`settleBatch`,
the only functions worth reentering into are already locked out for the
duration of the call. Reordering the loop to strictly follow
checks-effects-interactions would meaningfully complicate the
partial-payment/shortfall logic (see `docs/roadmap.md` #7) for a risk this
guard already closes — so this is accepted, not fixed, and documented here
rather than silently ignored.

### Accepted: external calls / storage writes inside a loop (`calls-loop`, `costly-loop`)

`settleBatch` calls `registry.recordSettlementOutcome` and
`insurancePool.coverDefault` once per net transfer, and increments
`totalUnresolvedShortfallMicros` on the shortfall path. Both patterns are
usually flagged because an attacker-controlled array length can turn a loop
into a gas-griefing or out-of-gas DoS vector. Here, the array is submitted
by `onlyOperator` — not by an arbitrary caller — and its length is bounded
by the netting engine's own output, which is provably at most
`n_agents_with_nonzero_balance - 1` (see `netting-engine/test/netting.test.ts`,
`never produces more than (n_agents - 1) transfers`). The operator has no
incentive to submit a batch so large it can't be mined, since they're the
one paying gas for it. Worth revisiting if the operator role is ever
decentralized or made permissionless (`docs/roadmap.md` #2) — an untrusted
submitter changes this calculus entirely.

### Dismissed: naming convention (`naming-convention`)

Slither wants setter parameters like `_operator` renamed to `operator`
(mixedCase without a leading underscore). Doing that would make the
parameter name identical to the state variable it's assigning
(`operator = _operator`), which Solidity permits but flags as shadowing —
trading one linter warning for a real one. The leading underscore is the
standard convention specifically to avoid that collision; not changing it.

### Dismissed: block.timestamp usage (`timestamp`)

Slither flags `AgentRegistry.registerAgent` and `.recordSettlementOutcome`
as "uses timestamp for comparisons." Reading the actual flagged lines shows
this is a false positive: the *comparisons* it points at are
`require(!agents[agent].registered, ...)` and `require(a.registered, ...)`
— plain boolean checks with no timestamp involved. The detector appears to
trigger because `block.timestamp` is written elsewhere in the same function
(`registeredAt: block.timestamp`) for record-keeping, not because timestamp
is used unsafely for access control or randomness. Confirmed by inspection,
not blindly dismissed.

## What this doesn't cover

Static analysis catches known patterns; it doesn't catch business-logic
bugs specific to this system's design (like the atomic-batch-revert issue
in `docs/roadmap.md` #7, which was found by load-testing, not by Slither).
It's one input among several — tests, manual review, and eventually a real
third-party audit before any of this touches real money — not a
substitute for any of them.
