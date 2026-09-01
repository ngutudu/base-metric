// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title IDIAWarrantOracle
/// @notice The on-chain contract DIA deploys and pushes updates into (§K.1 — pull model).
/// BaseMetric's WarrantPoRAdapter reads (pulls) from it; it never writes here.
/// DIA is the source of truth for reserve figures and for allowance issuance/revocation.
/// DIA never tracks "consumed" — that is BaseMetric-local state.
///
/// @dev `allowanceState`: 0 = none, 1 = issued, 3 = revoked (mirrors AllowanceState;
/// value 2 "consumed" is intentionally never produced by DIA).
interface IDIAWarrantOracle {
    /// @return reserveKg6dec aggregate verified reserve for the warehouse, kilograms 6dp
    /// @return updatedAt unix seconds of the last push for this warehouse (staleness input)
    /// @return seq monotonic sequence number of the last push
    function getReserve(bytes32 warehouseId)
        external
        view
        returns (uint256 reserveKg6dec, uint256 updatedAt, uint256 seq);

    /// @return warehouseId the warehouse holding this lot
    /// @return nettKg6dec verified nett weight of the lot, kilograms 6dp
    /// @return commodity free-text commodity descriptor, e.g. "lead"
    /// @return allowanceKg6dec amount authorised to mint against this receipt
    /// @return allowanceRecipient the whitelisted address the allowance names
    /// @return allowanceState 0 none · 1 issued · 3 revoked
    function getLot(bytes32 receiptId)
        external
        view
        returns (
            bytes32 warehouseId,
            uint256 nettKg6dec,
            string memory commodity,
            uint256 allowanceKg6dec,
            address allowanceRecipient,
            uint8 allowanceState
        );
}
