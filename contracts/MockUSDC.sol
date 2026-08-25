// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 6-decimal mock stablecoin used for local testing and demos.
/// Not for production use — swap for real USDC (or any settlement ERC20)
/// on live deployment.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "mUSDC") {
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet for local testing only.
    function faucet(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
