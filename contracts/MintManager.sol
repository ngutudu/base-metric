// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {BMTokenPOC} from "./BMTokenPOC.sol";
import {Treasury} from "./Treasury.sol";
import {BasemetricRegistry} from "./BasemetricRegistry.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {NavQuote, AllowanceState} from "./lib/BaseMetricTypes.sol";

/// @title MintManager
/// @notice Consumes a DIA allowance, mints the ATTESTED WEIGHT in tokens, and takes in
/// the matching USDC (§A.2). The money follows the metal — sizing is by allowance weight,
/// not by USDC.
/// @dev USDC is assumed to be a plain ERC-20 with no transfer hooks; combined with
/// checks-effects-interactions ordering (allowance is marked Consumed before any
/// external transfer), no reentrancy guard is needed.
contract MintManager is Ownable, Pausable, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 private constant NAV_QUOTE_TYPEHASH =
        keccak256("NavQuote(uint256 navPriceUsdc6PerKg,uint256 validUntil,uint256 nonce)");

    BMTokenPOC public immutable token;
    Treasury public immutable treasury;
    BasemetricRegistry public immutable registry;
    IERC20 public immutable usdc;

    address public navSigner; // issuer-controlled EIP-712 key
    uint256 public mintFeeBps; // 0 at Phase 0; Phase 1 target 75 (0.75%)

    /// A handful of base units — NOT a percentage (§H). $0.01 == 10_000 units max.
    uint256 public maxSettlementDrift;

    mapping(uint256 => bool) public usedNonces;

    event NavSignerSet(address navSigner);
    event MintFeeBpsSet(uint256 bps);
    event MaxSettlementDriftSet(uint256 units);
    event Minted(bytes32 indexed receiptId, address indexed recipient, uint256 mintAmountKg6dec, uint256 usdcAmount);

    error NoIssuedAllowance();
    error ZeroMintAmount();
    error RecipientNotAllowlisted();
    error BadNavSignature();
    error NavQuoteExpired();
    error NonceUsed();
    error SettlementDriftTooLarge();
    error ReserveStale();
    error PostMintReserveAssertion();

    constructor(
        address token_,
        address treasury_,
        address registry_,
        address usdc_,
        address navSigner_,
        uint256 maxSettlementDrift_
    ) Ownable(msg.sender) EIP712("BaseMetricMintManager", "1") {
        token = BMTokenPOC(token_);
        treasury = Treasury(treasury_);
        registry = BasemetricRegistry(registry_);
        usdc = IERC20(usdc_);
        navSigner = navSigner_;
        maxSettlementDrift = maxSettlementDrift_;
    }

    function setNavSigner(address s) external onlyOwner {
        navSigner = s;
        emit NavSignerSet(s);
    }

    function setMintFeeBps(uint256 bps) external onlyOwner {
        mintFeeBps = bps;
        emit MintFeeBpsSet(bps);
    }

    function setMaxSettlementDrift(uint256 units) external onlyOwner {
        maxSettlementDrift = units;
        emit MaxSettlementDriftSet(units);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Caller (the 3/3 Safe at Phase 0) must have approved this contract for `usdcAmount`.
    function mint(bytes32 receiptId, uint256 usdcAmount, NavQuote calldata navQuote, bytes calldata signature)
        external
        whenNotPaused
    {
        // 2. an allowance exists for receiptId and its state is Issued.
        // Cheap pre-check on the registry cache; the adapter re-reads DIA live inside
        // consumeAllowance() below, so a revoke landing after the last sync still blocks.
        BasemetricRegistry.Lot memory lot = registry.getLot(receiptId);
        if (lot.allowanceState != AllowanceState.Issued) revert NoIssuedAllowance();
        address recipient = lot.allowanceRecipient;

        // 3. allowance.recipient is on the transfer allowlist (Phase 0)
        if (!token.isAllowlisted(recipient)) revert RecipientNotAllowlisted();

        // Backstop assertion (§A.2): a stale reserve figure cannot be minted against.
        // Demoted from gate to assertion — the allowance is the gate now.
        if (registry.isStale(lot.warehouseId)) revert ReserveStale();

        // 4. NAV quote signature valid + within its validity window
        _verifyNavQuote(navQuote, signature);

        // Sizing rule (§A.2 / §H): the money follows the metal.
        uint256 mintAmountKg6dec = lot.allowanceKg6dec;
        if (mintAmountKg6dec == 0) revert ZeroMintAmount();
        uint256 usdcRequired = (mintAmountKg6dec * navQuote.navPriceUsdc6PerKg) / 1e6;

        // 5. usdcAmount matches the canonical settlement amount within MAX_SETTLEMENT_DRIFT
        uint256 drift = usdcAmount > usdcRequired ? usdcAmount - usdcRequired : usdcRequired - usdcAmount;
        if (drift > maxSettlementDrift) revert SettlementDriftTooLarge();

        // consume the allowance (only the adapter may write allowance state to the registry)
        IOracleAdapter(registry.adapterForLot(receiptId)).consumeAllowance(receiptId);

        // move USDC into Treasury
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        usdc.forceApprove(address(treasury), usdcAmount);
        treasury.deposit(usdcAmount);

        // mint the attested weight
        token.mint(recipient, mintAmountKg6dec);

        // 6. post-mint assertion: totalSupply() <= registry.getReserve()
        if (token.totalSupply() > registry.getReserve()) revert PostMintReserveAssertion();

        emit Minted(receiptId, recipient, mintAmountKg6dec, usdcAmount);
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
