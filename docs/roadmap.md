# Roadmap — what's real, what's next

This project is a working MVP with real, tested mechanics — not a mockup. This
document is deliberately explicit about the line between the two, because
that line matters for anyone deciding whether to build on this or fund it.

## What's actually built and tested right now

- **Multilateral netting engine** (`netting-engine/`) — collapses a raw
  micro-payment graph into net-per-agent positions, then into a minimized
  transfer set via a fast greedy heuristic (scales to thousands of agents)
  or an exact branch-and-bound solver for small graphs. 11/11 unit tests,
  including an end-to-end proof at scale.
- **x402-style off-chain payment authorizations** (`sdk/`) — EIP-712 signed,
  instantly verifiable offline, replay- and expiry-protected, gated by a
  locally-enforced credit limit. 8/8 unit tests.
- **On-chain settlement clearinghouse** (`contracts/`) — agents deposit
  collateral once; an authorized operator submits the netted transfer set in
  a single transaction; shortfalls are covered by a staker-funded insurance
  pool with reputation consequences for the defaulting agent. 5/5 Hardhat
  tests on a real EVM.
- **End-to-end integration**, verified live on a local chain: 4,200 signed
  and verified x402 authorizations netted to 18 on-chain transfers
  (99.6% reduction, 99.4% gas savings vs. naive per-payment settlement) —
  see `scripts/demo.ts` and its output in the main README.
- **Backend API + dashboard** — a real (if minimal) operational surface:
  `POST /api/pay`, `POST /api/settle`, `GET /api/stats`, `GET /api/agents`,
  plus a one-click traffic simulator for demos.
- **Graceful handling of under-reserved defaults** — `settleBatch()` no
  longer reverts an entire batch when one debtor's shortfall exceeds the
  insurance pool's available reserves (a real bug found by load-testing
  this exact flow, not merely anticipated). The under-reserved transfer now
  degrades to a partial payment plus an `UnresolvedShortfall` event; the
  backend listens for that event and carries the unpaid amount forward as a
  new obligation in the next netting cycle. Verified live: a batch with one
  uncollateralized defaulting agent among seven healthy transfers settled
  all eight — previously this reverted the whole transaction. See the new
  contract test and `POST /api/settle`'s `carriedForwardShortfalls` field.

## What's explicitly NOT built yet (and shouldn't be assumed)

### 1. Trustless / verifiable settlement
Today, a single `operator` address is trusted to submit the correct netted
batch. The contract records a `commitmentHash` per batch so the underlying
raw payment set is auditable after the fact, but there's no on-chain
mechanism to *contest* a bad batch. Two real paths forward, in increasing
order of complexity:
- **Fraud-proof + challenge window**: batches become final only after a
  dispute period; any agent can submit proof (the raw signed authorizations)
  that a batch under- or over-charged them, reverting/slashing the operator.
- **ZK netting proof**: the operator submits a succinct proof that the netted
  transfer set is a valid reduction of a committed raw payment set, verified
  on-chain in constant time. Stronger guarantee, more engineering.

### 2. Decentralized operator set
Right now it's one address. Moving to a small rotating quorum (or letting
anyone submit a batch, with the fraud-proof system above as the safety net)
removes the single point of trust/failure.

### 3. Portable agent identity/reputation
`AgentRegistry` is a simple, siloed reputation score. A serious version
would adopt (or interoperate with) a portable on-chain agent identity
standard — something in the spirit of ERC-8004 — so an agent's track record
travels across every clearinghouse it uses instead of starting at zero
everywhere.

### 4. Real insurance pricing
`InsurancePool` proves the mechanism — stakers absorb default risk pro rata
and earn fee yield for it — but has no risk-based pricing, tranching, or
per-staker risk selection. A production version would price coverage based
on the actual default distribution observed, likely with senior/junior
tranches so risk-tolerant capital can earn more for absorbing losses first.

### 5. Cross-chain / gas-optimal settlement routing
Settlement happens on whatever single chain the clearinghouse is deployed
to. A mature version would route each settlement to whichever chain/L2 is
cheapest at that moment, using an intent-solver pattern, and support agents
whose collateral lives on different chains.

### 6. Liquidity for pending receivables
An agent that's owed money mid-cycle currently just waits for the next
settlement. A natural extension: let that pending net-receivable be
tokenized and sold at a discount to a liquidity provider who wants it
settled instantly — invoice factoring for machines.

### 7. Even smarter shortfall handling
The MVP now carries an unresolved shortfall forward as a new obligation for
the *next* cycle (see above) instead of reverting the batch — but it does
this blindly, with no limit on how many cycles a shortfall can be deferred.
A more complete version would: (a) let the netting engine pre-check each
debtor's collateral + available insurance headroom *before* submitting a
batch, so healthy transfers and likely-uncoverable ones can be split
proactively rather than discovered on-chain; and (b) escalate — freeze the
defaulting agent's ability to authorize new payments, or force liquidation
of whatever collateral they do have — if a shortfall survives more than one
or two carry-forward cycles, rather than letting it accumulate indefinitely.

## Why ship the MVP without all of this

Every one of the above is a real, addressable engineering problem — none of
them are "this idea doesn't work." The MVP's job is to prove the core claim
end to end (netting genuinely collapses settlement volume by ~99% in a
realistic agent-mesh scenario) on real, tested code, and to make the trust
assumptions of the current version explicit rather than glossing over them.
