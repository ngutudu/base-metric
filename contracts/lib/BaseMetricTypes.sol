// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @dev Metal-neutral shared types. No metal appears in any identifier (§A naming rule).

/// Allowance lifecycle states (§B / §H struct additions).
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

// Reserve + per-lot allowance data now live in DIA's own oracle contract and are read
// through IDIAWarrantOracle (§K.1 — pull model). The old signed CanonicalAttestation
// payload struct is retired; its fields map 1:1 onto IDIAWarrantOracle.getLot/getReserve.

/// NAV price quote, signed EIP-712 by the issuer-controlled key (§D step 4).
struct NavQuote {
    uint256 navPriceUsdc6PerKg; // USDC per kg, 6dp
    uint256 validUntil; // quote validity window
    uint256 nonce;
}
