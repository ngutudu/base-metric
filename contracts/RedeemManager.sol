// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {BMTokenPOC} from "./BMTokenPOC.sol";
import {Treasury} from "./Treasury.sol";
import {BasemetricRegistry} from "./BasemetricRegistry.sol";
import {LotState, NavQuote} from "./lib/BaseMetricTypes.sol";

/// @title RedeemManager
/// @notice Burns tokens against a NAMED lot (§A.3). The burn is separable from the
/// settlement: the Phase 0 ceremony path pays USDC out atomically; the commercial
/// path does not (settlement is off-chain and later, on both title and cash elections).
/// The burn NEVER deducts the reserve — that happens on a later attestation triggered
/// by the Final Release Document (§A.3, §E).
/// @dev USDC is a plain ERC-20 (no transfer hooks); the burn marks lot state before
/// any Treasury withdrawal, so no reentrancy guard is needed.
contract RedeemManager is Ownable, Pausable, EIP712 {
    bytes32 private constant NAV_QUOTE_TYPEHASH =
        keccak256("NavQuote(uint256 navPriceUsdc6PerKg,uint256 validUntil,uint256 nonce)");

    BMTokenPOC public immutable token;
    Treasury public immutable treasury;
    BasemetricRegistry public immutable registry;

    address public navSigner; // issuer-controlled EIP-712 key (same key family as MintManager)
    uint256 public redeemFeeBps; // 0 at Phase 0; Phase 1 target 150 (1.5%), handled off-chain
    bool public ceremonyEnabled; // gates the atomic burn+payout path

    mapping(uint256 => bool) public usedNonces;

    event NavSignerSet(address navSigner);
    event RedeemFeeBpsSet(uint256 bps);
    event CeremonyEnabledSet(bool enabled);
    event Burned(bytes32 indexed receiptId, address indexed redeemer, uint256 burnAmountKg6dec);
    event CeremonySettled(bytes32 indexed receiptId, address indexed redeemer, uint256 usdcPayout);
    event DustBurned(address indexed from, uint256 amount);

    error NotWholeLot();
    error LotNotActive();
    error CeremonyDisabled();
    error BadNavSignature();
    error NavQuoteExpired();
    error NonceUsed();

    constructor(address token_, address treasury_, address registry_, address navSigner_)
        Ownable(msg.sender)
        EIP712("BaseMetricRedeemManager", "1")
    {
        token = BMTokenPOC(token_);
        treasury = Treasury(treasury_);
        registry = BasemetricRegistry(registry_);
        navSigner = navSigner_;
    }

    function setNavSigner(address s) external onlyOwner {
        navSigner = s;
        emit NavSignerSet(s);
    }

    function setRedeemFeeBps(uint256 bps) external onlyOwner {
        redeemFeeBps = bps;
        emit RedeemFeeBpsSet(bps);
    }

    function setCeremonyEnabled(bool enabled) external onlyOwner {
        ceremonyEnabled = enabled;
        emit CeremonyEnabledSet(enabled);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Commercial path — burn only. No Treasury withdrawal.
    /// Caller burns their own tokens; settlement happens off-chain and later.
    function redeem(bytes32 receiptId, uint256 burnAmountKg6dec) external whenNotPaused {
        _burnLot(receiptId, burnAmountKg6dec);
    }

    /// @notice Phase 0 ceremony path — burn plus atomic USDC payout from Treasury.
    /// The payout is DERIVED from a signed NAV quote (round trip at the same NAV → zero
    /// delta, §H) — it is never caller-supplied, so a redeemer cannot over-withdraw.
    function redeemCeremony(bytes32 receiptId, uint256 burnAmountKg6dec, NavQuote calldata navQuote, bytes calldata signature)
        external
        whenNotPaused
    {
        if (!ceremonyEnabled) revert CeremonyDisabled();
        _verifyNavQuote(navQuote, signature);

        _burnLot(receiptId, burnAmountKg6dec);

        uint256 usdcPayout = (burnAmountKg6dec * navQuote.navPriceUsdc6PerKg) / 1e6;
        treasury.withdraw(msg.sender, usdcPayout); // reverts if Treasury USDC is insufficient
        emit CeremonySettled(receiptId, msg.sender, usdcPayout);
    }

    /// Safety valve for a token-leg rounding residual. Not a routine step (§A.3).
    function adminBurnDust(uint256 amount) external onlyOwner {
        token.burn(msg.sender, amount);
        emit DustBurned(msg.sender, amount);
    }

    function _burnLot(bytes32 receiptId, uint256 burnAmountKg6dec) private {
        BasemetricRegistry.Lot memory lot = registry.getLot(receiptId);
        if (lot.lotState != LotState.Active) revert LotNotActive();
        // redemption is whole-lot; recordLot enforces allowanceKg6dec == nettKg6dec
        if (burnAmountKg6dec != lot.nettKg6dec) revert NotWholeLot();

        token.burn(msg.sender, burnAmountKg6dec); // totalSupply() falls; real OZ _burn
        registry.markLotRedeemed(receiptId);
        emit Burned(receiptId, msg.sender, burnAmountKg6dec);
    }

    function _verifyNavQuote(NavQuote calldata q, bytes calldata signature) private {
        if (block.timestamp > q.validUntil) revert NavQuoteExpired();
        if (usedNonces[q.nonce]) revert NonceUsed();
        bytes32 structHash = keccak256(abi.encode(NAV_QUOTE_TYPEHASH, q.navPriceUsdc6PerKg, q.validUntil, q.nonce));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != navSigner) revert BadNavSignature();
        usedNonces[q.nonce] = true;
    }
}
