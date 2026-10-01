// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {AllowanceState} from "../lib/BaseMetricTypes.sol";

/// @dev Load-bearing boundary (§A.4): the registry holds IOracleAdapter references,
/// not concrete pointers, so an oracle-vendor change is a drop-in at the registry level.
interface IOracleAdapter {
    function warehouseId() external view returns (uint256);

    function getReserve() external view returns (uint256);

    function allowanceOf(uint256 intentId)
        external
        view
        returns (uint256 amountKg6dec, address recipient, AllowanceState state);

    /// Consume the allowance for a lot. Only the configured MintManager may call.
    function consumeAllowance(uint256 intentId) external;

    // NOTE: revocation is intentionally NOT part of this interface. The signing scheme
    // for a revoke is vendor-specific and nothing downstream needs to call it
    // generically — only the concrete WarrantPoRAdapter exposes it.
}
