// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {AllowanceState} from "../lib/BaseMetricTypes.sol";

/// @dev Load-bearing boundary (§A.4): the registry holds IOracleAdapter references,
/// not concrete pointers, so an oracle-vendor change is a drop-in at the registry level.
/// Allowance methods live on the interface, not the concrete adapter (§I item 3).
interface IOracleAdapter {
    function warehouseId() external view returns (bytes32);

    function getReserve() external view returns (uint256);

    function allowanceOf(bytes32 receiptId)
        external
        view
        returns (uint256 amountKg6dec, address recipient, AllowanceState state);

    /// Consume the allowance for a lot. Only the configured MintManager may call.
    function consumeAllowance(bytes32 receiptId) external;

    /// Revoke an unconsumed allowance. Only the configured DIA revoke multisig may call.
    function revokeAllowance(bytes32 receiptId) external;
}
