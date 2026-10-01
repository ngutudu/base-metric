// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @dev Metal-neutral shared types. No metal appears in any identifier (§A naming rule).

/// Allowance lifecycle states (§B).
/// 0 none · 1 issued · 2 consumed · 3 revoked
enum AllowanceState {
    None,
    Issued,
    Consumed,
    Revoked
}

/// Lot lifecycle states.
/// 0 none · 1 active · 2 redeemed
enum LotState {
    None,
    Active,
    Redeemed
}

/// NAV price quote, signed EIP-712 by the issuer-controlled key (mint and ceremony redeem).
struct NavQuote {
    uint256 navPriceUsdc6PerKg; // USDC per kg, 6dp
    uint256 validUntil; // quote validity window
    uint256 nonce;
}

// ---------------------------------------------------------------------------
// DIA attestation payloads (push + verify-signature model — Flow Brief v7 §3.2).
// Confirmed with imaohw1 (DIA), 30 Sep:
//   - integer ids throughout (warehouse / intent / lot / receipt), not bytes32/hash
//   - `intentId` is DIA's internal, per-lot-UNIQUE handle — the actual key for mint
//     and burn/revoke. "Lot ID" can repeat when a lot changes hands; receipt number
//     is always unique but is NOT the mint/burn key, intentId is
//   - no separate sequence number: `timestamp` (scoped per warehouse) IS the
//     ordering key, and is ALSO checked for freshness (a max-age window)
//   - single EIP-712 attestor key for LotAttestation and FinalReleaseAttestation
//     (DIA's own routine attestation). RevokeAttestation is verified separately as
//     2-of-3, per Flow Brief v7 §1.2 term 4 (Basemetric holds one seat).
// ---------------------------------------------------------------------------

/// DIA verifies a warehouse receipt: raises the reserve and issues one allowance,
/// sized to the exact attested net weight (Flow Brief §1.2 term 2).
struct LotAttestation {
    uint256 warehouseId;
    uint256 intentId; // the unique mint/burn key
    uint256 lotId; // informational — can repeat if the lot changes hands
    uint256 receiptNumber; // informational — always unique, but not the on-chain key
    string commodity;
    uint256 nettKg6dec; // attested net weight — also the allowance amount, 1:1
    address allowanceRecipient; // the whitelisted wallet permitted to mint against it
    uint256 timestamp; // orders + bounds freshness; DIA's own signing time
}

/// Cancels an unconsumed allowance by "removing" its intentId (DIA's phrasing).
struct RevokeAttestation {
    uint256 intentId;
    uint256 timestamp;
}

/// DIA attests the Final Release Document after a redemption burn: the reserve
/// deducts here, not at the burn (§A.3 / Flow Brief §2). Quantity is looked up via
/// intentId, not resent.
struct FinalReleaseAttestation {
    uint256 intentId;
    uint256 timestamp;
}
