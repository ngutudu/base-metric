// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {IDIAWarrantOracle} from "./interfaces/IDIAWarrantOracle.sol";
import {BasemetricRegistry} from "./BasemetricRegistry.sol";
import {AllowanceState} from "./lib/BaseMetricTypes.sol";

/// @title WarrantPoRAdapter
/// @notice Thin reader over DIA's own oracle contract (§K.1 — pull model). DIA pushes
/// reserve + allowance updates into their contract; this adapter pulls them into
/// BasemetricRegistry. One instance per warehouse.
///
/// Trust model: the adapter trusts the configured DIA oracle address. There is no
/// signature or sequence check here — DIA's contract is itself the verified source,
/// and `sync()` is permissionless and idempotent, so no keeper role is needed.
contract WarrantPoRAdapter is IOracleAdapter, Ownable {
    bytes32 public immutable warehouseId;
    BasemetricRegistry public immutable registry;

    /// The DIA oracle contract. `feedAddress` name kept for the §A.4 setter contract.
    IDIAWarrantOracle public feedAddress;

    uint256 public lastSyncedSeq; // last DIA reserve seq copied into the registry
    address public mintManager; // the only caller allowed to consume allowances

    event FeedAddressSet(address feedAddress);
    event MintManagerSet(address mintManager);
    event Synced(bytes32 indexed receiptId, uint256 reserveKg6dec, uint256 seq);
    event RevocationPropagated(bytes32 indexed receiptId);

    error OnlyMintManager();
    error WrongWarehouse();
    error AllowanceNotIssuedOnDIA();
    error NotRevokedOnDIA();

    /// @dev Constructor shape unchanged from the June lock (§A.4). `_oracleFeed` is now
    /// the address of DIA's deployed oracle contract.
    constructor(bytes32 _warehouseId, address _oracleFeed, address _registry) Ownable(msg.sender) {
        warehouseId = _warehouseId;
        feedAddress = IDIAWarrantOracle(_oracleFeed);
        registry = BasemetricRegistry(_registry);
    }

    function setFeedAddress(address feed) external onlyOwner {
        feedAddress = IDIAWarrantOracle(feed);
        emit FeedAddressSet(feed);
    }

    function setMintManager(address m) external onlyOwner {
        mintManager = m;
        emit MintManagerSet(m);
    }

    // --------------------------------------------------------------------
    // Pull: copy DIA's current truth into the registry. Permissionless, idempotent.
    // --------------------------------------------------------------------
    /// @notice Sync the reserve and (first time only) record the lot for `receiptId`.
    /// Pass bytes32(0) to sync the reserve alone (§J attestations #2/#3).
    function sync(bytes32 receiptId) external {
        _syncReserve();

        if (receiptId == bytes32(0)) return;

        (
            bytes32 lotWarehouse,
            uint256 nettKg6dec,
            string memory commodity,
            uint256 allowanceKg6dec,
            address allowanceRecipient,
            uint8 diaState
        ) = feedAddress.getLot(receiptId);

        if (lotWarehouse != warehouseId) revert WrongWarehouse();

        if (!registry.isLot(receiptId)) {
            if (diaState != uint8(AllowanceState.Issued)) revert AllowanceNotIssuedOnDIA();
            registry.recordLot(
                warehouseId, receiptId, nettKg6dec, commodity, allowanceKg6dec, allowanceRecipient
            );
        } else if (diaState == uint8(AllowanceState.Revoked)) {
            _propagateRevocation(receiptId);
        }
    }

    /// @notice Propagate a DIA-side revocation into the registry. Permissionless — the
    /// DIA 2-of-3 multisig acts on DIA's contract; anyone may relay the result here.
    function revokeAllowance(bytes32 receiptId) external {
        (, , , , , uint8 diaState) = feedAddress.getLot(receiptId);
        if (diaState != uint8(AllowanceState.Revoked)) revert NotRevokedOnDIA();
        _propagateRevocation(receiptId);
    }

    // --------------------------------------------------------------------
    // IOracleAdapter
    // --------------------------------------------------------------------
    /// Live reserve straight from DIA's contract (freshest possible read).
    function getReserve() external view returns (uint256 reserveKg6dec) {
        (reserveKg6dec, , ) = feedAddress.getReserve(warehouseId);
    }

    /// Live allowance state straight from DIA — except once BaseMetric has marked it
    /// Consumed locally, that terminal state wins (DIA never sets Consumed).
    function allowanceOf(bytes32 receiptId)
        external
        view
        returns (uint256 amountKg6dec, address recipient, AllowanceState state)
    {
        (uint256 localAmount, address localRecipient, AllowanceState localState) = registry.allowanceOf(receiptId);
        if (localState == AllowanceState.Consumed) {
            return (localAmount, localRecipient, AllowanceState.Consumed);
        }
        (, , , uint256 diaAmount, address diaRecipient, uint8 diaState) = feedAddress.getLot(receiptId);
        return (diaAmount, diaRecipient, AllowanceState(diaState));
    }

    /// Consume the allowance atomically with the mint. Re-reads DIA live so a revoke
    /// that landed since the last sync still blocks the mint (the revoke race is
    /// resolved here, on-chain).
    function consumeAllowance(bytes32 receiptId) external {
        if (msg.sender != mintManager) revert OnlyMintManager();

        _syncReserve(); // refresh the reserve cache so the post-mint assertion is fresh

        (, , , , , uint8 diaState) = feedAddress.getLot(receiptId);
        if (diaState != uint8(AllowanceState.Issued)) revert AllowanceNotIssuedOnDIA();

        registry.markAllowanceConsumed(receiptId);
    }

    // --------------------------------------------------------------------
    // internals
    // --------------------------------------------------------------------
    function _syncReserve() private {
        (uint256 reserveKg6dec, , uint256 seq) = feedAddress.getReserve(warehouseId);
        if (seq >= lastSyncedSeq) {
            lastSyncedSeq = seq;
            registry.updateReserve(warehouseId, reserveKg6dec, bytes32(seq));
            emit Synced(bytes32(0), reserveKg6dec, seq);
        }
    }

    function _propagateRevocation(bytes32 receiptId) private {
        (, , AllowanceState localState) = registry.allowanceOf(receiptId);
        if (localState == AllowanceState.Issued) {
            registry.markAllowanceRevoked(receiptId);
            emit RevocationPropagated(receiptId);
        }
    }
}
