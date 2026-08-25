// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title InsurancePool
/// @notice A simple share-based vault that backstops agent credit risk.
/// Stakers deposit the settlement token and receive shares; the pool's
/// value per share rises as settlement fee yield is deposited, and falls
/// if the pool has to cover a defaulted agent's shortfall (a "slash" that
/// is socialized pro-rata across all stakers, mirroring how EigenLayer-style
/// restaking pools underwrite slashable risk).
///
/// This is deliberately NOT a full ERC-4626 vault or a production risk
/// engine — there's no tranching, no per-staker risk selection, and no
/// insurance pricing curve. Those are the natural next steps; this contract
/// exists to prove the mechanism (agents can safely be extended credit
/// because *someone* is bonded against their default) end to end.
contract InsurancePool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable settlementToken;
    address public clearinghouse;

    uint256 public totalShares;
    uint256 public totalAssets;
    mapping(address => uint256) public sharesOf;

    event Deposited(address indexed staker, uint256 amount, uint256 shares);
    event Withdrawn(address indexed staker, uint256 amount, uint256 shares);
    event YieldAdded(uint256 amount, uint256 newTotalAssets);
    event DefaultCovered(address indexed agent, uint256 amount, uint256 newTotalAssets);
    event ClearinghouseSet(address indexed clearinghouse);

    error InsufficientReserves(uint256 requested, uint256 available);

    modifier onlyClearinghouse() {
        require(msg.sender == clearinghouse, "InsurancePool: not clearinghouse");
        _;
    }

    constructor(address _settlementToken, address initialOwner) Ownable(initialOwner) {
        settlementToken = IERC20(_settlementToken);
    }

    error ZeroAddress();

    function setClearinghouse(address _clearinghouse) external onlyOwner {
        if (_clearinghouse == address(0)) revert ZeroAddress();
        clearinghouse = _clearinghouse;
        emit ClearinghouseSet(_clearinghouse);
    }

    function pricePerShare() public view returns (uint256) {
        if (totalShares == 0) return 1e18;
        return (totalAssets * 1e18) / totalShares;
    }

    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "InsurancePool: zero amount");
        uint256 newShares = totalShares == 0 ? amount : (amount * totalShares) / totalAssets;

        totalAssets += amount;
        totalShares += newShares;
        sharesOf[msg.sender] += newShares;

        settlementToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, newShares);
    }

    function withdraw(uint256 shareAmount) external nonReentrant {
        require(shareAmount > 0 && shareAmount <= sharesOf[msg.sender], "InsurancePool: bad share amount");
        uint256 assetAmount = (shareAmount * totalAssets) / totalShares;

        sharesOf[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        totalAssets -= assetAmount;

        settlementToken.safeTransfer(msg.sender, assetAmount);
        emit Withdrawn(msg.sender, assetAmount, shareAmount);
    }

    /// @notice Clearinghouse deposits a slice of settlement fees here; this
    /// raises pricePerShare for every staker without minting new shares —
    /// their yield for underwriting agent credit risk.
    function addYield(uint256 amount) external nonReentrant onlyClearinghouse {
        settlementToken.safeTransferFrom(msg.sender, address(this), amount);
        totalAssets += amount;
        emit YieldAdded(amount, totalAssets);
    }

    /// @notice Called by the clearinghouse when a batch settlement finds an
    /// agent short of funds. Sends the shortfall to the clearinghouse (which
    /// credits it to the underpaid counterparty's ledger balance in the same
    /// transaction), socializing the loss across all stakers by reducing
    /// pricePerShare.
    function coverDefault(address agent, uint256 amount) external nonReentrant onlyClearinghouse {
        if (amount > totalAssets) revert InsufficientReserves(amount, totalAssets);
        totalAssets -= amount;
        settlementToken.safeTransfer(msg.sender, amount);
        emit DefaultCovered(agent, amount, totalAssets);
    }
}
