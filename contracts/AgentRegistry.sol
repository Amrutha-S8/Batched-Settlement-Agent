// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title AgentRegistry
/// @notice Tracks agent identity, reputation, and the resulting off-chain
/// credit line each agent is allowed to run up between settlements.
///
/// Reputation is intentionally simple in this MVP (integer score, moved by
/// the settlement operator based on real settlement outcomes). Roadmap:
/// replace with a portable, cross-app agent identity/reputation standard
/// (e.g. ERC-8004-style) so an agent's track record travels with it instead
/// of being siloed per-clearinghouse.
contract AgentRegistry is Ownable {
    enum Tier {
        UNREGISTERED,
        NEW,
        ESTABLISHED,
        TRUSTED
    }

    struct Agent {
        bool registered;
        int256 reputationScore; // can go negative after defaults
        uint256 registeredAt;
        uint256 successfulSettlements;
        uint256 defaults;
    }

    mapping(address => Agent) public agents;

    // Operators are the off-chain services (netting engine / clearinghouse
    // contract) allowed to move reputation based on real settlement events.
    mapping(address => bool) public operators;

    // Credit limits per tier, denominated in the settlement token's smallest
    // unit (e.g. for 6-decimal USDC, 5_000_000 = $5.00). Owner-tunable so
    // the risk parameters can be adjusted without redeploying.
    mapping(Tier => uint256) public tierCreditLimit;

    event AgentRegistered(address indexed agent, uint256 timestamp);
    event ReputationUpdated(address indexed agent, int256 newScore, bool wasDefault);
    event OperatorSet(address indexed operator, bool allowed);
    event TierLimitUpdated(Tier tier, uint256 limit);

    modifier onlyOperator() {
        require(operators[msg.sender], "AgentRegistry: not operator");
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        // Default risk tiers — tune via setTierCreditLimit.
        tierCreditLimit[Tier.NEW] = 500_000; // $0.50 running tab for unproven agents
        tierCreditLimit[Tier.ESTABLISHED] = 20_000_000; // $20
        tierCreditLimit[Tier.TRUSTED] = 250_000_000; // $250
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setTierCreditLimit(Tier tier, uint256 limit) external onlyOwner {
        require(tier != Tier.UNREGISTERED, "AgentRegistry: bad tier");
        tierCreditLimit[tier] = limit;
        emit TierLimitUpdated(tier, limit);
    }

    function registerAgent(address agent) external {
        require(!agents[agent].registered, "AgentRegistry: already registered");
        agents[agent] = Agent({
            registered: true,
            reputationScore: 0,
            registeredAt: block.timestamp,
            successfulSettlements: 0,
            defaults: 0
        });
        emit AgentRegistered(agent, block.timestamp);
    }

    /// @notice Called by the clearinghouse after each settlement batch to
    /// reward agents who paid in full and penalize ones who defaulted into
    /// the insurance pool.
    function recordSettlementOutcome(address agent, bool defaulted) external onlyOperator {
        Agent storage a = agents[agent];
        require(a.registered, "AgentRegistry: not registered");

        if (defaulted) {
            a.defaults += 1;
            a.reputationScore -= 50;
        } else {
            a.successfulSettlements += 1;
            a.reputationScore += 1;
        }

        emit ReputationUpdated(agent, a.reputationScore, defaulted);
    }

    function tierOf(address agent) public view returns (Tier) {
        Agent storage a = agents[agent];
        if (!a.registered) return Tier.UNREGISTERED;
        if (a.defaults > 0 && a.reputationScore < 0) return Tier.NEW; // demoted after any default until score recovers
        if (a.reputationScore >= 500) return Tier.TRUSTED;
        if (a.reputationScore >= 100) return Tier.ESTABLISHED;
        return Tier.NEW;
    }

    /// @notice Max off-chain, unsettled balance this agent is allowed to
    /// accumulate before the netting engine must force an early settlement
    /// for that agent.
    function creditLimitOf(address agent) external view returns (uint256) {
        Tier t = tierOf(agent);
        if (t == Tier.UNREGISTERED) return 0;
        return tierCreditLimit[t];
    }

    function isRegistered(address agent) external view returns (bool) {
        return agents[agent].registered;
    }
}
