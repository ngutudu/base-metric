// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {AllowanceState, LotState} from "./lib/BaseMetricTypes.sol";

/// @title BasemetricRegistry
/// @notice Source of truth for warehouse reserve state AND lot-level allowance state (§A.5).
/// Per-lot records with FIFO ordering; getReserve() still returns the aggregate so
/// nothing downstream changes.
contract BasemetricRegistry is Ownable {
    // --- warehouse state ---
    struct Warehouse {
        IOracleAdapter adapter;
        bool active;
        uint256 reserveKg6dec; // aggregate reserve for this warehouse
        uint256 attestationTimestamp;
        bytes32 attestationHash;
        uint256 staleThresholdSeconds;
    }

    // --- per-lot state (new in r4) ---
    struct Lot {
        bytes32 warehouseId;
        bytes32 receiptId;
        uint256 nettKg6dec;
        string commodity;
        uint256 allowanceKg6dec;
        address allowanceRecipient;
        AllowanceState allowanceState;
        LotState lotState;
        uint256 insertionIndex; // FIFO ordering
    }

    uint256 public constant DEFAULT_STALE_THRESHOLD = 24 hours;

    mapping(bytes32 => Warehouse) private _warehouses;
    mapping(address => bool) public isRegisteredAdapter;
    bytes32[] private _allWarehouseIds;

    mapping(bytes32 => Lot) private _lots; // receiptId => Lot
    mapping(bytes32 => bytes32[]) private _warehouseLots; // warehouseId => receiptIds in insertion order
    mapping(bytes32 => uint256) private _fifoCursor; // warehouseId => index of next candidate lot
    uint256 private _lotCounter;

    address public redeemManager; // authorised to mark lots redeemed

    event WarehouseRegistered(bytes32 indexed warehouseId, address adapter);
    event WarehouseDeregistered(bytes32 indexed warehouseId);
    event ReserveUpdated(bytes32 indexed warehouseId, uint256 reserveKg6dec, uint256 timestamp);
    event LotRecorded(bytes32 indexed warehouseId, bytes32 indexed receiptId, uint256 nettKg6dec, string commodity);
    event AllowanceIssued(bytes32 indexed receiptId, address indexed recipient, uint256 amountKg6dec);
    event AllowanceConsumed(bytes32 indexed receiptId);
    event AllowanceRevoked(bytes32 indexed receiptId);
    event LotRedeemed(bytes32 indexed receiptId);
    event RedeemManagerSet(address redeemManager);

    error NotRegisteredAdapter();
    error NotAdapterForWarehouse();
    error WarehouseNotActive();
    error WarehouseExists();
    error UnknownWarehouse();
    error LotExists();
    error UnknownLot();
    error BadAllowanceTransition();
    error BadLotTransition();
    error NotRedeemManager();
    error AllowanceWeightMismatch();
    error ZeroRecipient();

    constructor() Ownable(msg.sender) {}

    // --------------------------------------------------------------------
    // Warehouse admin
    // --------------------------------------------------------------------
    function registerWarehouse(bytes32 warehouseId, address adapter) external onlyOwner {
        if (_warehouses[warehouseId].adapter != IOracleAdapter(address(0))) revert WarehouseExists();
        _warehouses[warehouseId] = Warehouse({
            adapter: IOracleAdapter(adapter),
            active: true,
            reserveKg6dec: 0,
            attestationTimestamp: 0,
            attestationHash: bytes32(0),
            staleThresholdSeconds: DEFAULT_STALE_THRESHOLD
        });
        isRegisteredAdapter[adapter] = true;
        _allWarehouseIds.push(warehouseId);
        emit WarehouseRegistered(warehouseId, adapter);
    }

    function deregisterWarehouse(bytes32 warehouseId) external onlyOwner {
        Warehouse storage w = _warehouses[warehouseId];
        if (address(w.adapter) == address(0)) revert UnknownWarehouse();
        isRegisteredAdapter[address(w.adapter)] = false;
        w.active = false;
        emit WarehouseDeregistered(warehouseId);
    }

    function setStaleThreshold(bytes32 warehouseId, uint256 secondsThreshold) external onlyOwner {
        if (address(_warehouses[warehouseId].adapter) == address(0)) revert UnknownWarehouse();
        _warehouses[warehouseId].staleThresholdSeconds = secondsThreshold;
    }

    function setRedeemManager(address redeemManager_) external onlyOwner {
        redeemManager = redeemManager_;
        emit RedeemManagerSet(redeemManager_);
    }

    // --------------------------------------------------------------------
    // Adapter-only writes
    // --------------------------------------------------------------------
    modifier onlyAdapterFor(bytes32 warehouseId) {
        if (!isRegisteredAdapter[msg.sender]) revert NotRegisteredAdapter();
        if (address(_warehouses[warehouseId].adapter) != msg.sender) revert NotAdapterForWarehouse();
        if (!_warehouses[warehouseId].active) revert WarehouseNotActive();
        _;
    }

    /// Update the aggregate reserve figure for a warehouse from a verified attestation.
    function updateReserve(bytes32 warehouseId, uint256 reserveKg6dec, bytes32 attestationHash)
        external
        onlyAdapterFor(warehouseId)
    {
        Warehouse storage w = _warehouses[warehouseId];
        w.reserveKg6dec = reserveKg6dec;
        w.attestationTimestamp = block.timestamp;
        w.attestationHash = attestationHash;
        emit ReserveUpdated(warehouseId, reserveKg6dec, block.timestamp);
    }

    /// Record a verified lot and its allowance (§D step 3).
    function recordLot(
        bytes32 warehouseId,
        bytes32 receiptId,
        uint256 nettKg6dec,
        string calldata commodity,
        uint256 allowanceKg6dec,
        address allowanceRecipient
    ) external onlyAdapterFor(warehouseId) {
        if (_lots[receiptId].receiptId != bytes32(0)) revert LotExists();
        if (allowanceRecipient == address(0)) revert ZeroRecipient();
        // Phase 0: one allowance == one full verified lot (§B). Multi-lot subscription
        // arity (one allowance for combined weight) is open — §K.2 — and would relax this.
        if (allowanceKg6dec != nettKg6dec) revert AllowanceWeightMismatch();
        _lots[receiptId] = Lot({
            warehouseId: warehouseId,
            receiptId: receiptId,
            nettKg6dec: nettKg6dec,
            commodity: commodity,
            allowanceKg6dec: allowanceKg6dec,
            allowanceRecipient: allowanceRecipient,
            allowanceState: AllowanceState.Issued,
            lotState: LotState.Active,
            insertionIndex: _lotCounter++
        });
        _warehouseLots[warehouseId].push(receiptId);
        emit LotRecorded(warehouseId, receiptId, nettKg6dec, commodity);
        emit AllowanceIssued(receiptId, allowanceRecipient, allowanceKg6dec);
    }

    function markAllowanceConsumed(bytes32 receiptId) external {
        Lot storage lot = _requireLot(receiptId);
        if (address(_warehouses[lot.warehouseId].adapter) != msg.sender) revert NotAdapterForWarehouse();
        if (lot.allowanceState != AllowanceState.Issued) revert BadAllowanceTransition();
        lot.allowanceState = AllowanceState.Consumed;
        emit AllowanceConsumed(receiptId);
    }

    function markAllowanceRevoked(bytes32 receiptId) external {
        Lot storage lot = _requireLot(receiptId);
        if (address(_warehouses[lot.warehouseId].adapter) != msg.sender) revert NotAdapterForWarehouse();
        if (lot.allowanceState != AllowanceState.Issued) revert BadAllowanceTransition();
        lot.allowanceState = AllowanceState.Revoked;
        emit AllowanceRevoked(receiptId);
    }

    /// Mark a lot redeemed. Called by RedeemManager after the burn (§A.3).
    /// This is lot state, not allowance state, so RedeemManager may call directly.
    function markLotRedeemed(bytes32 receiptId) external {
        if (msg.sender != redeemManager) revert NotRedeemManager();
        Lot storage lot = _requireLot(receiptId);
        if (lot.lotState != LotState.Active) revert BadLotTransition();
        lot.lotState = LotState.Redeemed;
        _advanceFifoCursor(lot.warehouseId);
        emit LotRedeemed(receiptId);
    }

    // --------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------
    /// Aggregate reserve across all warehouses (kilograms, 6dp).
    function getReserve() external view returns (uint256 total) {
        // Phase 0 is a single warehouse; loop is bounded by warehouse count.
        // getReserve() with a warehouseId is available below for per-site reads.
        return _aggregateReserve();
    }

    function getReserve(bytes32 warehouseId) external view returns (uint256) {
        return _warehouses[warehouseId].reserveKg6dec;
    }

    function _aggregateReserve() private view returns (uint256 total) {
        bytes32[] storage ids = _allWarehouseIds;
        for (uint256 i = 0; i < ids.length; i++) {
            Warehouse storage w = _warehouses[ids[i]];
            if (w.active) total += w.reserveKg6dec;
        }
    }

    function isStale(bytes32 warehouseId) external view returns (bool) {
        Warehouse storage w = _warehouses[warehouseId];
        if (w.attestationTimestamp == 0) return true;
        return block.timestamp - w.attestationTimestamp > w.staleThresholdSeconds;
    }

    function isReserveDeficit(bytes32 warehouseId, uint256 tokenSupplyKg6dec) external view returns (bool) {
        return _warehouses[warehouseId].reserveKg6dec < tokenSupplyKg6dec;
    }

    function allowanceOf(bytes32 receiptId)
        external
        view
        returns (uint256 amountKg6dec, address recipient, AllowanceState state)
    {
        Lot storage lot = _lots[receiptId];
        return (lot.allowanceKg6dec, lot.allowanceRecipient, lot.allowanceState);
    }

    function isLot(bytes32 receiptId) external view returns (bool) {
        return _lots[receiptId].receiptId != bytes32(0);
    }

    function getLot(bytes32 receiptId) external view returns (Lot memory) {
        return _requireLot(receiptId);
    }

    function adapterForLot(bytes32 receiptId) external view returns (address) {
        return address(_warehouses[_requireLot(receiptId).warehouseId].adapter);
    }

    function warehouseLotCount(bytes32 warehouseId) external view returns (uint256) {
        return _warehouseLots[warehouseId].length;
    }

    /// Next active lot in FIFO order for a warehouse (§A.5, §E step 1).
    /// Returns bytes32(0) when none.
    function nextLotFIFO(bytes32 warehouseId) external view returns (bytes32) {
        bytes32[] storage ids = _warehouseLots[warehouseId];
        for (uint256 i = _fifoCursor[warehouseId]; i < ids.length; i++) {
            if (_lots[ids[i]].lotState == LotState.Active) return ids[i];
        }
        return bytes32(0);
    }

    // --------------------------------------------------------------------
    // internals
    // --------------------------------------------------------------------
    function _advanceFifoCursor(bytes32 warehouseId) private {
        bytes32[] storage ids = _warehouseLots[warehouseId];
        uint256 i = _fifoCursor[warehouseId];
        while (i < ids.length && _lots[ids[i]].lotState != LotState.Active) {
            i++;
        }
        _fifoCursor[warehouseId] = i;
    }

    function _requireLot(bytes32 receiptId) private view returns (Lot storage lot) {
        lot = _lots[receiptId];
        if (lot.receiptId == bytes32(0)) revert UnknownLot();
    }
}
