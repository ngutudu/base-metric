// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title BMTokenPOC
/// @notice Metal-neutral ERC-20. 1 token = 1 kg of the deployed metal, 6 decimals (§A.1).
/// name/symbol are constructor params — Phase 0 deploys as "BaseMetric Lead POC" / bmLEAD.
/// No rebasing, no transfer hooks, no fee-on-transfer.
contract BMTokenPOC is ERC20Pausable, Ownable {
    address public mintManager;
    address public redeemManager;

    bool public phase0TransferLock;
    mapping(address => bool) public isAllowlisted; // TRANSFER_ALLOWLIST_ROLE members

    event MintManagerSet(address mintManager);
    event RedeemManagerSet(address redeemManager);
    event Phase0TransferLockSet(bool locked);
    event AllowlistSet(address indexed account, bool allowed);

    error OnlyMintManager();
    error OnlyRedeemManager();
    error TransferLocked();
    error RecipientNotAllowlisted();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) Ownable(msg.sender) {
        phase0TransferLock = true;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // --- wiring ---
    function setMintManager(address m) external onlyOwner {
        mintManager = m;
        emit MintManagerSet(m);
    }

    function setRedeemManager(address r) external onlyOwner {
        redeemManager = r;
        emit RedeemManagerSet(r);
    }

    function setPhase0TransferLock(bool locked) external onlyOwner {
        phase0TransferLock = locked;
        emit Phase0TransferLockSet(locked);
    }

    function setAllowlist(address account, bool allowed) external onlyOwner {
        isAllowlisted[account] = allowed;
        emit AllowlistSet(account, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // --- mint / burn ---
    /// Only MintManager can mint. A mint to a de-whitelisted recipient MUST revert (§A.1, §F stop 1).
    function mint(address to, uint256 amount) external {
        if (msg.sender != mintManager) revert OnlyMintManager();
        if (phase0TransferLock && !isAllowlisted[to]) revert RecipientNotAllowlisted();
        _mint(to, amount);
    }

    /// Only RedeemManager can burn. Real OZ _burn so totalSupply() decreases exactly (§A.1).
    function burn(address from, uint256 amount) external {
        if (msg.sender != redeemManager) revert OnlyRedeemManager();
        _burn(from, amount);
    }

    // --- Phase 0 transfer lock ---
    function _update(address from, address to, uint256 value) internal override {
        // Allow mint (from == 0) and burn (to == 0) regardless of lock.
        if (phase0TransferLock && from != address(0) && to != address(0)) {
            if (!isAllowlisted[from] && !isAllowlisted[to]) revert TransferLocked();
        }
        super._update(from, to, value);
    }
}
