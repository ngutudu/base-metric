// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IDIAWarrantOracle} from "../interfaces/IDIAWarrantOracle.sol";

/// @notice Test/dev stand-in for DIA's deployed oracle contract. In production DIA
/// owns and pushes to the real one; here the setters simulate those pushes.
contract MockDIAWarrantOracle is IDIAWarrantOracle {
    struct ReserveData {
        uint256 reserveKg6dec;
        uint256 updatedAt;
        uint256 seq;
    }

    struct LotData {
        bytes32 warehouseId;
        uint256 nettKg6dec;
        string commodity;
        uint256 allowanceKg6dec;
        address allowanceRecipient;
        uint8 allowanceState; // 0 none · 1 issued · 3 revoked
    }

    mapping(bytes32 => ReserveData) private _reserves;
    mapping(bytes32 => LotData) private _lots;

    function pushReserve(bytes32 warehouseId, uint256 reserveKg6dec, uint256 seq) external {
        _reserves[warehouseId] = ReserveData(reserveKg6dec, block.timestamp, seq);
    }

    function pushLot(
        bytes32 receiptId,
        bytes32 warehouseId,
        uint256 nettKg6dec,
        string calldata commodity,
        uint256 allowanceKg6dec,
        address allowanceRecipient
    ) external {
        _lots[receiptId] = LotData(warehouseId, nettKg6dec, commodity, allowanceKg6dec, allowanceRecipient, 1);
    }

    function revoke(bytes32 receiptId) external {
        _lots[receiptId].allowanceState = 3;
    }

    function getReserve(bytes32 warehouseId)
        external
        view
        returns (uint256 reserveKg6dec, uint256 updatedAt, uint256 seq)
    {
        ReserveData memory r = _reserves[warehouseId];
        return (r.reserveKg6dec, r.updatedAt, r.seq);
    }

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
        )
    {
        LotData memory l = _lots[receiptId];
        return (l.warehouseId, l.nettKg6dec, l.commodity, l.allowanceKg6dec, l.allowanceRecipient, l.allowanceState);
    }
}
