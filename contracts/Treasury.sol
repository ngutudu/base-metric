// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Treasury
/// @notice Holds USDC backing the mint/redeem flow (§A.6). Unchanged in r4.
/// deposit only by MintManager; withdraw only by RedeemManager; adminWithdraw by multisig owner.
contract Treasury is Ownable, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public mintManager;
    address public redeemManager;

    event MintManagerSet(address mintManager);
    event RedeemManagerSet(address redeemManager);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event AdminWithdrawn(address indexed to, uint256 amount);

    error OnlyMintManager();
    error OnlyRedeemManager();
    error InsufficientBalance();

    constructor(address usdc_, address multisig) Ownable(multisig) {
        usdc = IERC20(usdc_);
    }

    function setMintManager(address m) external onlyOwner {
        mintManager = m;
        emit MintManagerSet(m);
    }

    function setRedeemManager(address r) external onlyOwner {
        redeemManager = r;
        emit RedeemManagerSet(r);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// Pull USDC in. MintManager must have approved this contract for `amount`.
    function deposit(uint256 amount) external whenNotPaused {
        if (msg.sender != mintManager) revert OnlyMintManager();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// Pay USDC out to a redeemer. Reverts if the balance is insufficient (§A.6 risk control).
    function withdraw(address to, uint256 amount) external whenNotPaused {
        if (msg.sender != redeemManager) revert OnlyRedeemManager();
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientBalance();
        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function adminWithdraw(address to, uint256 amount) external onlyOwner {
        usdc.safeTransfer(to, amount);
        emit AdminWithdrawn(to, amount);
    }

    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
