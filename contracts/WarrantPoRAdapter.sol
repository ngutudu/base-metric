// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {BasemetricRegistry} from "./BasemetricRegistry.sol";
import {AllowanceState, LotAttestation, RevokeAttestation, FinalReleaseAttestation} from "./lib/BaseMetricTypes.sol";

/// @title WarrantPoRAdapter
/// @notice Push + verify-signature model. DIA (or anyone relaying a signed payload —
/// the signature is what authenticates it, not the caller) submits one of three
/// signed attestation types; the adapter verifies the signature(s) and timestamp
/// ordering/freshness, then writes into BasemetricRegistry. One instance per
/// warehouse.
///
/// Issue (`postAttestation`) and `finalRelease` are DIA's own routine attestation of
/// what they verified — single EIP-712 signer (`feedAddress`), per DIA (30 Sep).
/// `revoke` is a separate, cross-party governance action (Flow Brief v7 §1.2 term 4:
/// "2-of-3 multisig with Basemetric as a signer", explicitly so revocation does not
/// depend on DIA acting alone) — verified as 2-of-3 raw ECDSA signatures against
/// `revokeSigners`, independent of `feedAddress`.
contract WarrantPoRAdapter is IOracleAdapter, Ownable, Pausable, EIP712 {
    bytes32 private constant LOT_ATTESTATION_TYPEHASH = keccak256(
        "LotAttestation(uint256 warehouseId,uint256 intentId,uint256 lotId,uint256 receiptNumber,string commodity,uint256 nettKg6dec,address allowanceRecipient,uint256 timestamp)"
    );
    bytes32 private constant REVOKE_ATTESTATION_TYPEHASH =
        keccak256("RevokeAttestation(uint256 intentId,uint256 timestamp)");
    bytes32 private constant FINAL_RELEASE_ATTESTATION_TYPEHASH =
        keccak256("FinalReleaseAttestation(uint256 intentId,uint256 timestamp)");

    uint256 public immutable warehouseId;
    BasemetricRegistry public immutable registry;

    /// DIA's single EIP-712 attestor key — used for `postAttestation` and
    /// `finalRelease` only (DIA's own routine attestation of what they verified).
    /// `feedAddress` name kept for the §A.4 setter contract.
    address public feedAddress;

    uint256 public constant REVOKE_THRESHOLD = 2; // 2-of-3 (Flow Brief §1.2 term 4)
    /// The 2-of-3 revoke signer set, Basemetric holding one seat — independent of
    /// `feedAddress`, so revocation does not depend on DIA acting alone.
    address[3] public revokeSigners;

    uint256 public lastTimestamp; // ordering key, shared across all 3 message types
    uint256 public maxAttestationAge = 24 hours; // freshness window — TBD, tune once DIA's real push latency is known
    address public mintManager; // the only caller allowed to consume allowances

    event FeedAddressSet(address feedAddress);
    event RevokeSignersSet(address[3] signers);
    event MaxAttestationAgeSet(uint256 seconds_);
    event MintManagerSet(address mintManager);
    event AttestationProcessed(uint256 indexed intentId, uint256 timestamp, uint8 kind); // 0 issue · 1 revoke · 2 finalRelease

    error OnlyMintManager();
    error WrongWarehouse();
    error StaleOrZeroTimestamp();
    error AttestationTooOld();
    error FutureTimestamp();
    error BadSigner();
    error InsufficientRevokeSignatures();
    error DuplicateOrUnknownRevokeSigner();

    /// @dev Constructor shape unchanged from the June lock (§A.4). `_oracleFeed` is
    /// DIA's single attestor signer address.
    constructor(uint256 _warehouseId, address _oracleFeed, address _registry)
        Ownable(msg.sender)
        EIP712("BaseMetricPoR", "1")
    {
        warehouseId = _warehouseId;
        feedAddress = _oracleFeed;
        registry = BasemetricRegistry(_registry);
    }

    function setFeedAddress(address feed) external onlyOwner {
        feedAddress = feed;
        emit FeedAddressSet(feed);
    }

    function setRevokeSigners(address[3] calldata signers) external onlyOwner {
        revokeSigners = signers;
        emit RevokeSignersSet(signers);
    }

    function setMaxAttestationAge(uint256 seconds_) external onlyOwner {
        maxAttestationAge = seconds_;
        emit MaxAttestationAgeSet(seconds_);
    }

    function setMintManager(address m) external onlyOwner {
        mintManager = m;
        emit MintManagerSet(m);
    }

    /// Emergency stop — e.g. suspected compromise of `feedAddress`. Blocks all
    /// ingest and consumption through this adapter until lifted.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // --------------------------------------------------------------------
    // Ingest — permissionless. Authenticity comes from the signature, not msg.sender.
    // --------------------------------------------------------------------

    /// DIA verifies a warehouse receipt: records the lot, raises the reserve, issues
    /// the allowance (§D step 3).
    function postAttestation(LotAttestation calldata a, bytes calldata signature) external whenNotPaused {
        if (a.warehouseId != warehouseId) revert WrongWarehouse();
        _checkOrdering(a.timestamp);

        bytes32 structHash = keccak256(
            abi.encode(
                LOT_ATTESTATION_TYPEHASH,
                a.warehouseId,
                a.intentId,
                a.lotId,
                a.receiptNumber,
                keccak256(bytes(a.commodity)),
                a.nettKg6dec,
                a.allowanceRecipient,
                a.timestamp
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != feedAddress) revert BadSigner();

        registry.recordLot(
            warehouseId, a.intentId, a.lotId, a.receiptNumber, a.nettKg6dec, a.commodity, a.allowanceRecipient, a.timestamp
        );
        emit AttestationProcessed(a.intentId, a.timestamp, 0);
    }

    /// Cancel an unconsumed allowance by "removing" its intentId (DIA's phrasing).
    /// Requires 2-of-3 signatures from `revokeSigners`, in the same order the signer
    /// set is configured — a slot may be left empty (`""`) if unused; only 2 of the
    /// 3 need to be non-empty and valid.
    function revoke(RevokeAttestation calldata r, bytes[3] calldata signatures) external whenNotPaused {
        _checkOrdering(r.timestamp);

        bytes32 structHash = keccak256(abi.encode(REVOKE_ATTESTATION_TYPEHASH, r.intentId, r.timestamp));
        bytes32 digest = _hashTypedDataV4(structHash);

        uint256 valid = 0;
        for (uint256 i = 0; i < 3; i++) {
            if (signatures[i].length == 0) continue;
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer != revokeSigners[i]) revert DuplicateOrUnknownRevokeSigner();
            valid++;
        }
        if (valid < REVOKE_THRESHOLD) revert InsufficientRevokeSignatures();

        registry.markAllowanceRevoked(r.intentId, r.timestamp);
        emit AttestationProcessed(r.intentId, r.timestamp, 1);
    }

    /// DIA attests the Final Release Document after a redemption burn: the reserve
    /// deducts here (§A.3 / §E step 8), not at the burn. Quantity is looked up via
    /// intentId, not resent (confirmed with DIA).
    function finalRelease(FinalReleaseAttestation calldata f, bytes calldata signature) external whenNotPaused {
        _checkOrdering(f.timestamp);

        bytes32 structHash =
            keccak256(abi.encode(FINAL_RELEASE_ATTESTATION_TYPEHASH, f.intentId, f.timestamp));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != feedAddress) revert BadSigner();

        registry.markReserveReleased(f.intentId, f.timestamp);
        emit AttestationProcessed(f.intentId, f.timestamp, 2);
    }

    // --------------------------------------------------------------------
    // IOracleAdapter
    // --------------------------------------------------------------------
    function getReserve() external view returns (uint256) {
        return registry.getReserve(warehouseId);
    }

    function allowanceOf(uint256 intentId)
        external
        view
        returns (uint256 amountKg6dec, address recipient, AllowanceState state)
    {
        return registry.allowanceOf(intentId);
    }

    /// Consume the allowance atomically with the mint. No live re-check against an
    /// external contract — revoke (2-of-3) is itself a verified on-chain write
    /// against the registry, so the mint/revoke race is resolved purely by
    /// transaction ordering (§B): whichever lands first in a block wins.
    function consumeAllowance(uint256 intentId) external whenNotPaused {
        if (msg.sender != mintManager) revert OnlyMintManager();
        registry.markAllowanceConsumed(intentId);
    }

    // --------------------------------------------------------------------
    // internals
    // --------------------------------------------------------------------
    /// @dev timestamp doubles as the anti-replay ordering key (strictly increasing,
    /// scoped to this warehouse/adapter) AND is bounded by a freshness window, per DIA.
    function _checkOrdering(uint256 timestamp) private {
        if (timestamp == 0 || timestamp <= lastTimestamp) revert StaleOrZeroTimestamp();
        if (timestamp > block.timestamp) revert FutureTimestamp();
        if (block.timestamp - timestamp > maxAttestationAge) revert AttestationTooOld();
        lastTimestamp = timestamp;
    }
}
