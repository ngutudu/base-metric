// Minimal ABI fragments — only what the test console actually calls.

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

export const USDC_ABI = [...ERC20_ABI, "function mint(address to, uint256 amount)"];

export const TOKEN_ABI = [
  ...ERC20_ABI,
  "function isAllowlisted(address) view returns (bool)",
  "function setAllowlist(address account, bool allowed)",
  "function phase0TransferLock() view returns (bool)",
  "function setPhase0TransferLock(bool locked)",
  "function pause()",
  "function unpause()",
  "function paused() view returns (bool)",
];

export const REGISTRY_ABI = [
  "function getReserve() view returns (uint256)",
  "function getReserve(uint256 warehouseId) view returns (uint256)",
  "function isStale(uint256 warehouseId) view returns (bool)",
  "function isReserveDeficit(uint256 warehouseId, uint256 tokenSupplyKg6dec) view returns (bool)",
  "function allowanceOf(uint256 intentId) view returns (uint256 amountKg6dec, address recipient, uint8 state)",
  "function isLot(uint256 intentId) view returns (bool)",
  "function getLot(uint256 intentId) view returns (tuple(uint256 warehouseId, uint256 intentId, uint256 lotId, uint256 receiptNumber, uint256 nettKg6dec, string commodity, address allowanceRecipient, uint8 allowanceState, uint8 lotState, bool reserveReleased, uint256 insertionIndex))",
  "function nextLotFIFO(uint256 warehouseId) view returns (uint256 intentId, bool found)",
  "function warehouseLotCount(uint256 warehouseId) view returns (uint256)",
];

export const ADAPTER_ABI = [
  "function warehouseId() view returns (uint256)",
  "function feedAddress() view returns (address)",
  "function revokeSigners(uint256) view returns (address)",
  "function lastTimestamp() view returns (uint256)",
  "function maxAttestationAge() view returns (uint256)",
  "function paused() view returns (bool)",
  "function setFeedAddress(address feed)",
  "function setRevokeSigners(address[3] signers)",
  "function setMaxAttestationAge(uint256 seconds_)",
  "function pause()",
  "function unpause()",
  "function postAttestation(tuple(uint256 warehouseId, uint256 intentId, uint256 lotId, uint256 receiptNumber, string commodity, uint256 nettKg6dec, address allowanceRecipient, uint256 timestamp) a, bytes signature)",
  "function revoke(tuple(uint256 intentId, uint256 timestamp) r, bytes[3] signatures)",
  "function finalRelease(tuple(uint256 intentId, uint256 timestamp) f, bytes signature)",
];

export const MINT_MANAGER_ABI = [
  "function mint(uint256 intentId, uint256 usdcAmount, tuple(uint256 navPriceUsdc6PerKg, uint256 validUntil, uint256 nonce) navQuote, bytes signature)",
  "function maxSettlementDrift() view returns (uint256)",
  "function setMaxSettlementDrift(uint256 units)",
  "function navSigner() view returns (address)",
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
];

export const REDEEM_MANAGER_ABI = [
  "function redeem(uint256 intentId, uint256 burnAmountKg6dec)",
  "function redeemCeremony(uint256 intentId, uint256 burnAmountKg6dec, tuple(uint256 navPriceUsdc6PerKg, uint256 validUntil, uint256 nonce) navQuote, bytes signature)",
  "function ceremonyEnabled() view returns (bool)",
  "function setCeremonyEnabled(bool enabled)",
  "function adminBurnDust(uint256 amount)",
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
];

export const TREASURY_ABI = ["function balance() view returns (uint256)"];
