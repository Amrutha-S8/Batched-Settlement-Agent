// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./AgentRegistry.sol";
import "./InsurancePool.sol";

/// @title SettlementClearinghouse
/// @notice Agents deposit collateral once, then transact off-chain all day
/// via instantly-verifiable x402-style signed authorizations. Rather than
/// settling each micro-payment on-chain, an off-chain netting engine
/// collapses the whole day's payment graph down to the minimum set of net
/// transfers (multilateral netting, like a derivatives clearinghouse) and
/// submits that minimal set here in a single transaction.
///
/// TRUST MODEL (read this before calling it "trustless"):
/// This MVP uses a single authorized `operator` address to submit batches —
/// it does NOT include on-chain verification of the underlying signed
/// authorizations or a fraud-proof/dispute window. `commitmentHash` anchors
/// the full off-chain transaction set (e.g. published to IPFS/Arweave) so a
/// batch is auditable after the fact, but nothing here yet lets an agent
/// contest a bad batch on-chain. See docs/roadmap.md for the path to a
/// verifiable/decentralized operator set (ZK netting proofs or a fraud-proof
/// + challenge window, plus a multi-operator quorum instead of one address).
contract SettlementClearinghouse is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable settlementToken;
    AgentRegistry public registry;
    InsurancePool public insurancePool;

    address public operator;
    uint16 public feeBps = 5; // 0.05% of settled volume, routed to insurance pool as staker yield

    mapping(address => uint256) public balanceOf; // agent's on-chain settled collateral, held by this contract

    uint256 public batchCount;
    uint256 public totalRawMicropaymentsSettled;
    uint256 public totalNetTransfersExecuted;
    uint256 public totalVolumeSettled;
    uint256 public totalUnresolvedShortfallMicros;

    struct BatchRecord {
        uint256 rawTransactionCount;
        uint256 netTransferCount;
        uint256 totalVolume;
        bytes32 commitmentHash;
        uint256 timestamp;
    }

    mapping(uint256 => BatchRecord) public batches;

    event Deposited(address indexed agent, uint256 amount);
    event Withdrawn(address indexed agent, uint256 amount);
    event OperatorSet(address indexed operator);
    event RegistrySet(address indexed registry);
    event InsurancePoolSet(address indexed pool);
    event FeeBpsSet(uint16 feeBps);

    event BatchSettled(
        uint256 indexed batchId,
        uint256 rawTransactionCount,
        uint256 netTransferCount,
        uint256 totalVolume,
        bytes32 commitmentHash
    );
    event NetTransferExecuted(uint256 indexed batchId, address indexed from, address indexed to, uint256 amount);
    event AgentDefaulted(uint256 indexed batchId, address indexed agent, uint256 shortfall, bool coveredByInsurance);
    /// @notice Emitted when a debtor's shortfall exceeds what the insurance
    /// pool can currently cover. The creditor is paid whatever the debtor
    /// actually had; this event is the on-chain record of the *remaining*
    /// unpaid amount so the off-chain netting engine can carry it forward
    /// as a new obligation (debtor -> creditor) in the next settlement
    /// cycle, rather than the whole batch reverting and blocking every
    /// other — perfectly healthy — transfer alongside it.
    event UnresolvedShortfall(uint256 indexed batchId, address indexed debtor, address indexed creditor, uint256 shortfallMicros);

    error NotOperator();
    error ArrayLengthMismatch();
    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 available);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address _settlementToken, address _registry, address initialOwner) Ownable(initialOwner) {
        settlementToken = IERC20(_settlementToken);
        registry = AgentRegistry(_registry);
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    error ZeroAddress();

    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
        emit OperatorSet(_operator);
    }

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert ZeroAddress();
        registry = AgentRegistry(_registry);
        emit RegistrySet(_registry);
    }

    function setInsurancePool(address _pool) external onlyOwner {
        if (_pool == address(0)) revert ZeroAddress();
        insurancePool = InsurancePool(_pool);
        emit InsurancePoolSet(_pool);
    }

    function setFeeBps(uint16 _feeBps) external onlyOwner {
        require(_feeBps <= 100, "SettlementClearinghouse: fee too high"); // hard cap at 1%
        feeBps = _feeBps;
        emit FeeBpsSet(_feeBps);
    }

    // ---------------------------------------------------------------
    // Agent collateral management
    // ---------------------------------------------------------------

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        balanceOf[msg.sender] += amount;
        settlementToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientBalance(amount, bal);
        balanceOf[msg.sender] = bal - amount;
        settlementToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------
    // Batched settlement — the core mechanism
    // ---------------------------------------------------------------

    /// @notice Submit the netted result of a day's (or hour's) worth of
    /// off-chain micro-payments. `debtors[i]` net-owes `amounts[i]` to
    /// `creditors[i]`. This array should already be the *minimized* transfer
    /// set produced by the off-chain netting engine — not the raw
    /// micro-payment list. `rawTransactionCount` (the number of underlying
    /// x402 authorizations this batch represents) is supplied purely for
    /// on-chain transparency/stats and is not used for accounting.
    function settleBatch(
        address[] calldata debtors,
        address[] calldata creditors,
        uint256[] calldata amounts,
        uint256 rawTransactionCount,
        bytes32 commitmentHash
    ) external nonReentrant onlyOperator {
        uint256 len = debtors.length;
        if (len != creditors.length || len != amounts.length) revert ArrayLengthMismatch();

        uint256 batchId = batchCount++;
        uint256 batchVolume = 0;
        uint256 feeAccrued = 0;

        for (uint256 i = 0; i < len; i++) {
            address debtor = debtors[i];
            address creditor = creditors[i];
            uint256 amount = amounts[i];
            if (amount == 0) continue;

            batchVolume += amount;
            uint256 available = balanceOf[debtor];

            if (available >= amount) {
                // Happy path: debtor fully covers their net obligation.
                uint256 fee = (amount * feeBps) / 10_000;
                uint256 net = amount - fee;

                balanceOf[debtor] = available - amount;
                balanceOf[creditor] += net;
                feeAccrued += fee;

                _recordOutcome(debtor, false);
            } else {
                // Shortfall: pay out what the debtor has, and try to cover
                // the rest from the insurance pool. Wrapped in try/catch so
                // that if the pool doesn't currently have enough reserves,
                // THIS transfer degrades to a partial payment instead of
                // reverting the whole transaction — every other net
                // transfer in the batch still settles normally.
                uint256 shortfall = amount - available;
                balanceOf[debtor] = 0;
                balanceOf[creditor] += available;

                bool coveredByInsurance = false;
                if (address(insurancePool) != address(0)) {
                    try insurancePool.coverDefault(debtor, shortfall) {
                        balanceOf[creditor] += shortfall;
                        coveredByInsurance = true;
                    } catch {
                        totalUnresolvedShortfallMicros += shortfall;
                        emit UnresolvedShortfall(batchId, debtor, creditor, shortfall);
                    }
                } else {
                    totalUnresolvedShortfallMicros += shortfall;
                    emit UnresolvedShortfall(batchId, debtor, creditor, shortfall);
                }

                _recordOutcome(debtor, true);
                emit AgentDefaulted(batchId, debtor, shortfall, coveredByInsurance);
            }

            emit NetTransferExecuted(batchId, debtor, creditor, amount);
        }

        if (feeAccrued > 0 && address(insurancePool) != address(0)) {
            settlementToken.forceApprove(address(insurancePool), feeAccrued);
            insurancePool.addYield(feeAccrued);
        }

        batches[batchId] = BatchRecord({
            rawTransactionCount: rawTransactionCount,
            netTransferCount: len,
            totalVolume: batchVolume,
            commitmentHash: commitmentHash,
            timestamp: block.timestamp
        });

        totalRawMicropaymentsSettled += rawTransactionCount;
        totalNetTransfersExecuted += len;
        totalVolumeSettled += batchVolume;

        emit BatchSettled(batchId, rawTransactionCount, len, batchVolume, commitmentHash);
    }

    function _recordOutcome(address agent, bool defaulted) internal {
        if (address(registry) == address(0)) return;
        if (!registry.isRegistered(agent)) return;
        // Reputation is informational for the demo — never let it revert a
        // real settlement.
        try registry.recordSettlementOutcome(agent, defaulted) {} catch {}
    }

    // ---------------------------------------------------------------
    // Views / stats — powers the "naive batching vs. netting" dashboard
    // ---------------------------------------------------------------

    function settlementRatio() external view returns (uint256 bpsOfRawKept) {
        if (totalRawMicropaymentsSettled == 0) return 0;
        return (totalNetTransfersExecuted * 10_000) / totalRawMicropaymentsSettled;
    }

    function getBatch(uint256 batchId) external view returns (BatchRecord memory) {
        return batches[batchId];
    }
}
