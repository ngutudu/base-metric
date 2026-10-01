// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {AllowanceState, LotState} from "./lib/BaseMetricTypes.sol";

/// @title BasemetricRegistry
/// @notice Source of truth for warehouse reserve state AND lot-level allowance state (§A.5).
/// Per-lot records with FIFO ordering. The reserve is NOT transmitted as a running total —
/// it is derived on-chain: +nettKg6dec when a lot is recorded (issued), -nettKg6dec when
/// its reserve is released (post-redemption Final Release attestation). Confirmed with
/// DIA (imaohw1, 30 Sep): they push the net-weight delta per lot; "it will be aggregated
/// in the smart contract" — i.e. here.
///
/// IDs are integers throughout (warehouse / intent / lot / receipt), per DIA (30 Sep):
/// integer ids, not hashes, "due to names being more complex and error prone".
/// `intentId` is the on-chain key — DIA's per-lot-unique handle, used for both mint and
/// burn/revoke. "Lot ID" can repeat when a lot changes hands, so it is NOT a valid key;
/// receipt number is always unique but is informational only here.
contract BasemetricRegistry is Ownable {
    // --- warehouse state ---
    struct Warehouse {
        IOracleAdapter adapter;
        bool active;
        uint256 reserveKg6dec; // derived aggregate reserve for this warehouse
        uint256 attestationTimestamp; // DIA's own signed timestamp of the last event processed
        uint256 staleThresholdSeconds;
    }

    // --- per-lot state ---
    struct Lot {
        uint256 warehouseId;
        uint256 intentId; // the on-chain key (mint/burn/revoke reference)
        uint256 lotId; // informational — can repeat
        uint256 receiptNumber; // informational — always unique, but not the key
        uint256 nettKg6dec; // attested weight == allowance amount, 1:1 (§B, Flow Brief §1.2)
        string commodity;
        address allowanceRecipient;
        AllowanceState allowanceState;
        LotState lotState;
        bool reserveReleased; // true once the Final Release attestation has been processed
        uint256 insertionIndex; // FIFO ordering
    }

    uint256 public constant DEFAULT_STALE_THRESHOLD = 24 hours;

    mapping(uint256 => Warehouse) private _warehouses;
    mapping(address => bool) public isRegisteredAdapter;
    uint256[] private _allWarehouseIds;

    mapping(uint256 => Lot) private _lots; // intentId => Lot
    mapping(uint256 => uint256[]) private _warehouseLots; // warehouseId => intentIds in insertion order
    mapping(uint256 => uint256) private _fifoCursor; // warehouseId => index of next candidate lot
    uint256 private _lotCounter;

    address public redeemManager; // authorised to mark lots redeemed

    event WarehouseRegistered(uint256 indexed warehouseId, address adapter);
    event WarehouseDeregistered(uint256 indexed warehouseId);
    event ReserveIncreased(uint256 indexed warehouseId, uint256 byKg6dec, uint256 newTotalKg6dec);
    event ReserveReleased(uint256 indexed warehouseId, uint256 indexed intentId, uint256 byKg6dec, uint256 newTotalKg6dec);
    event ReserveReversed(uint256 indexed warehouseId, uint256 indexed intentId, uint256 byKg6dec, uint256 newTotalKg6dec);
    event LotRecorded(uint256 indexed warehouseId, uint256 indexed intentId, uint256 nettKg6dec, string commodity);
    event AllowanceIssued(uint256 indexed intentId, address indexed recipient, uint256 amountKg6dec);
    event AllowanceConsumed(uint256 indexed intentId);
    event AllowanceRevoked(uint256 indexed intentId);
    event LotRedeemed(uint256 indexed intentId);
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
    error ZeroRecipient();
    error ReserveAlreadyReleased();
    error LotNotRedeemedYet();

    constructor() Ownable(msg.sender) {}

    // --------------------------------------------------------------------
    // Warehouse admin
    // --------------------------------------------------------------------
    function registerWarehouse(uint256 warehouseId, address adapter) external onlyOwner {
        if (_warehouses[warehouseId].adapter != IOracleAdapter(address(0))) revert WarehouseExists();
        _warehouses[warehouseId] = Warehouse({
            adapter: IOracleAdapter(adapter),
            active: true,
            reserveKg6dec: 0,
            attestationTimestamp: 0,
            staleThresholdSeconds: DEFAULT_STALE_THRESHOLD
        });
        isRegisteredAdapter[adapter] = true;
        _allWarehouseIds.push(warehouseId);
        emit WarehouseRegistered(warehouseId, adapter);
    }

    function deregisterWarehouse(uint256 warehouseId) external onlyOwner {
        Warehouse storage w = _warehouses[warehouseId];
        if (address(w.adapter) == address(0)) revert UnknownWarehouse();
        isRegisteredAdapter[address(w.adapter)] = false;
        w.active = false;
        emit WarehouseDeregistered(warehouseId);
    }

    function setStaleThreshold(uint256 warehouseId, uint256 secondsThreshold) external onlyOwner {
        if (address(_warehouses[warehouseId].adapter) == address(0)) revert UnknownWarehouse();
        _warehouses[warehouseId].staleThresholdSeconds = secondsThreshold;
    }

    function setRedeemManager(address redeemManager_) external onlyOwner {
        redeemManager = redeemManager_;
        emit RedeemManagerSet(redeemManager_);
    }

    // --------------------------------------------------------------------
    // Adapter-only writes — the adapter has already verified DIA's signature
    // before calling any of these (§A.4: signer + timestamp ordering verified upstream).
    // --------------------------------------------------------------------
    modifier onlyAdapterFor(uint256 warehouseId) {
        if (!isRegisteredAdapter[msg.sender]) revert NotRegisteredAdapter();
        if (address(_warehouses[warehouseId].adapter) != msg.sender) revert NotAdapterForWarehouse();
        if (!_warehouses[warehouseId].active) revert WarehouseNotActive();
        _;
    }

    /// Record a newly verified lot: issues its allowance and raises the reserve by
    /// exactly its weight (§D step 3, Flow Brief "the reserve figure increases
    /// automatically, and one allowance is issued for that lot").
    function recordLot(
        uint256 warehouseId,
        uint256 intentId,
        uint256 lotId,
        uint256 receiptNumber,
        uint256 nettKg6dec,
        string calldata commodity,
        address allowanceRecipient,
        uint256 attestedAt
    ) external onlyAdapterFor(warehouseId) {
        if (_lots[intentId].allowanceRecipient != address(0)) revert LotExists();
        if (allowanceRecipient == address(0)) revert ZeroRecipient();

        _lots[intentId] = Lot({
            warehouseId: warehouseId,
            intentId: intentId,
            lotId: lotId,
            receiptNumber: receiptNumber,
            nettKg6dec: nettKg6dec,
            commodity: commodity,
            allowanceRecipient: allowanceRecipient,
            allowanceState: AllowanceState.Issued,
            lotState: LotState.Active,
            reserveReleased: false,
            insertionIndex: _lotCounter++
        });
        _warehouseLots[warehouseId].push(intentId);

        Warehouse storage w = _warehouses[warehouseId];
        w.reserveKg6dec += nettKg6dec;
        w.attestationTimestamp = attestedAt;

        emit LotRecorded(warehouseId, intentId, nettKg6dec, commodity);
        emit AllowanceIssued(intentId, allowanceRecipient, nettKg6dec);
        emit ReserveIncreased(warehouseId, nettKg6dec, w.reserveKg6dec);
    }

    function markAllowanceConsumed(uint256 intentId) external {
        Lot storage lot = _requireLot(intentId);
        if (address(_warehouses[lot.warehouseId].adapter) != msg.sender) revert NotAdapterForWarehouse();
        if (lot.allowanceState != AllowanceState.Issued) revert BadAllowanceTransition();
        lot.allowanceState = AllowanceState.Consumed;
        emit AllowanceConsumed(intentId);
    }

    /// Revoking an unconsumed allowance also reverses the reserve it added at issuance
    /// (§revoke reserve accounting): a revoked lot can never reach Redeemed, so it would
    /// otherwise inflate `reserve` forever with no way to unwind it — and if DIA later
    /// re-attests the same physical lot under a new intentId, that re-issuance correctly
    /// adds the weight back exactly once instead of double-counting it.
    function markAllowanceRevoked(uint256 intentId, uint256 attestedAt) external {
        Lot storage lot = _requireLot(intentId);
        if (address(_warehouses[lot.warehouseId].adapter) != msg.sender) revert NotAdapterForWarehouse();
        if (lot.allowanceState != AllowanceState.Issued) revert BadAllowanceTransition();
        lot.allowanceState = AllowanceState.Revoked;

        Warehouse storage w = _warehouses[lot.warehouseId];
        w.reserveKg6dec -= lot.nettKg6dec;
        w.attestationTimestamp = attestedAt;

        emit AllowanceRevoked(intentId);
        emit ReserveReversed(lot.warehouseId, intentId, lot.nettKg6dec, w.reserveKg6dec);
    }

    /// Mark a lot redeemed. Called by RedeemManager after the burn (§A.3).
    /// This is lot state, not allowance state, so RedeemManager may call directly.
    function markLotRedeemed(uint256 intentId) external {
        if (msg.sender != redeemManager) revert NotRedeemManager();
        Lot storage lot = _requireLot(intentId);
        if (lot.lotState != LotState.Active) revert BadLotTransition();
        lot.lotState = LotState.Redeemed;
        _advanceFifoCursor(lot.warehouseId);
        emit LotRedeemed(intentId);
    }

    /// Release the reserve held against a redeemed lot, triggered by DIA's Final
    /// Release Document attestation (§A.3 / §E step 8) — NOT by the burn itself.
    function markReserveReleased(uint256 intentId, uint256 attestedAt) external {
        Lot storage lot = _requireLot(intentId);
        if (address(_warehouses[lot.warehouseId].adapter) != msg.sender) revert NotAdapterForWarehouse();
        if (lot.lotState != LotState.Redeemed) revert LotNotRedeemedYet();
        if (lot.reserveReleased) revert ReserveAlreadyReleased();

        lot.reserveReleased = true;
        Warehouse storage w = _warehouses[lot.warehouseId];
        w.reserveKg6dec -= lot.nettKg6dec;
        w.attestationTimestamp = attestedAt;

        emit ReserveReleased(lot.warehouseId, intentId, lot.nettKg6dec, w.reserveKg6dec);
    }

    // --------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------
    /// Aggregate reserve across all warehouses (kilograms, 6dp).
    function getReserve() external view returns (uint256 total) {
        return _aggregateReserve();
    }

    function getReserve(uint256 warehouseId) external view returns (uint256) {
        return _warehouses[warehouseId].reserveKg6dec;
    }

    function _aggregateReserve() private view returns (uint256 total) {
        uint256[] storage ids = _allWarehouseIds;
        for (uint256 i = 0; i < ids.length; i++) {
            Warehouse storage w = _warehouses[ids[i]];
            if (w.active) total += w.reserveKg6dec;
        }
    }

    function isStale(uint256 warehouseId) external view returns (bool) {
        Warehouse storage w = _warehouses[warehouseId];
        if (w.attestationTimestamp == 0) return true;
        return block.timestamp - w.attestationTimestamp > w.staleThresholdSeconds;
    }

    function isReserveDeficit(uint256 warehouseId, uint256 tokenSupplyKg6dec) external view returns (bool) {
        return _warehouses[warehouseId].reserveKg6dec < tokenSupplyKg6dec;
    }

    function allowanceOf(uint256 intentId)
        external
        view
        returns (uint256 amountKg6dec, address recipient, AllowanceState state)
    {
        Lot storage lot = _lots[intentId];
        return (lot.nettKg6dec, lot.allowanceRecipient, lot.allowanceState);
    }

    function isLot(uint256 intentId) external view returns (bool) {
        return _lots[intentId].allowanceRecipient != address(0);
    }

    function getLot(uint256 intentId) external view returns (Lot memory) {
        return _requireLot(intentId);
    }

    function adapterForLot(uint256 intentId) external view returns (address) {
        return address(_warehouses[_requireLot(intentId).warehouseId].adapter);
    }

    function warehouseLotCount(uint256 warehouseId) external view returns (uint256) {
        return _warehouseLots[warehouseId].length;
    }

    /// Next lot actually redeemable, in FIFO order (§A.5, §E step 1): `lotState ==
    /// Active` is not enough on its own — a revoked lot keeps that lotState forever
    /// (it can never reach Redeemed, since RedeemManager requires `allowanceState ==
    /// Consumed`), so a revoked lot must also be skipped here, or it would block the
    /// cursor on a lot nobody can ever redeem. `intentId` 0 is a legitimately usable
    /// key (see _requireLot), so "no candidate found" is reported via `found`, not by
    /// overloading the returned id as a sentinel.
    function nextLotFIFO(uint256 warehouseId) external view returns (uint256 intentId, bool found) {
        uint256[] storage ids = _warehouseLots[warehouseId];
        for (uint256 i = _fifoCursor[warehouseId]; i < ids.length; i++) {
            if (_isRedeemable(ids[i])) return (ids[i], true);
        }
        return (0, false);
    }

    // --------------------------------------------------------------------
    // internals
    // --------------------------------------------------------------------
    function _advanceFifoCursor(uint256 warehouseId) private {
        uint256[] storage ids = _warehouseLots[warehouseId];
        uint256 i = _fifoCursor[warehouseId];
        while (i < ids.length && !_isRedeemable(ids[i])) {
            i++;
        }
        _fifoCursor[warehouseId] = i;
    }

    /// A lot is a live FIFO candidate only once it's actually been minted
    /// (allowance Consumed) and not yet redeemed — matching RedeemManager's own gate.
    /// A revoked (never-minted) lot must be treated the same as a redeemed one here,
    /// or it would permanently block the cursor.
    function _isRedeemable(uint256 intentId) private view returns (bool) {
        Lot storage lot = _lots[intentId];
        return lot.lotState == LotState.Active && lot.allowanceState == AllowanceState.Consumed;
    }

    /// @dev A lot "exists" iff its recipient has been set (non-zero) — intentId 0 is
    /// never itself written as a struct field we can null-check, so we key existence
    /// off allowanceRecipient instead (recordLot always rejects a zero recipient).
    function _requireLot(uint256 intentId) private view returns (Lot storage lot) {
        lot = _lots[intentId];
        if (lot.allowanceRecipient == address(0)) revert UnknownLot();
    }
}
