// Covers what smoke-test.mjs doesn't: redeem (commercial), revoke (2-of-3), finalRelease.
import { ethers } from "ethers";
import deployment from "./src/deployment.json" with { type: "json" };
import { HARDHAT_ACCOUNTS } from "./src/accounts.js";
import { ADAPTER_ABI, REGISTRY_ABI, MINT_MANAGER_ABI, REDEEM_MANAGER_ABI, TOKEN_ABI, USDC_ABI } from "./src/abis.js";
import { signLotAttestation, signRevokeAttestation, signFinalReleaseAttestation, signNavQuote } from "./src/eip712.js";

const provider = new ethers.JsonRpcProvider(deployment.rpcUrl, deployment.chainId);
const _wallets = new Map();
function wallet(label) {
  if (_wallets.has(label)) return _wallets.get(label);
  const a = HARDHAT_ACCOUNTS.find((x) => x.label === label);
  const w = new ethers.NonceManager(new ethers.Wallet(a.privateKey, provider));
  _wallets.set(label, w);
  return w;
}

const adapter = new ethers.Contract(deployment.contracts.adapter, ADAPTER_ABI, provider);
const registry = new ethers.Contract(deployment.contracts.registry, REGISTRY_ABI, provider);
const token = new ethers.Contract(deployment.contracts.token, TOKEN_ABI, wallet("deployer"));
const usdc = new ethers.Contract(deployment.contracts.usdc, USDC_ABI, wallet("deployer"));
const mintManager = new ethers.Contract(deployment.contracts.mintManager, MINT_MANAGER_ABI, provider);
const redeemManager = new ethers.Contract(deployment.contracts.redeemManager, REDEEM_MANAGER_ABI, provider);

const chainId = deployment.chainId;
const recipient = deployment.roles.recipient;

// _checkOrdering requires a strictly increasing timestamp per adapter — two calls
// within the same wall-clock second will otherwise collide (StaleOrZeroTimestamp).
async function nextTimestamp() {
  const last = await adapter.lastTimestamp();
  const now = BigInt(Math.floor(Date.now() / 1000));
  return last >= now ? last + 1n : now;
}

async function mintLot(intentId, kg) {
  const a = {
    warehouseId: BigInt(deployment.warehouseId),
    intentId,
    lotId: intentId,
    receiptNumber: intentId,
    commodity: "lead",
    nettKg6dec: BigInt(kg) * 1_000_000n,
    allowanceRecipient: recipient,
    timestamp: await nextTimestamp(),
  };
  const sig = await signLotAttestation(wallet("diaSigner"), deployment.contracts.adapter, chainId, a);
  await (await adapter.connect(wallet("other")).postAttestation(a, sig)).wait();
  await (await token.setAllowlist(recipient, true)).wait();

  const navPrice = 2_000_000n;
  const usdcRequired = (a.nettKg6dec * navPrice) / 1_000_000n;
  await (await usdc.mint(deployment.roles.safe, usdcRequired)).wait();
  await (await usdc.connect(wallet("safe")).approve(deployment.contracts.mintManager, usdcRequired)).wait();
  const quote = { navPriceUsdc6PerKg: navPrice, validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: BigInt(intentId) * 1000n };
  const navSig = await signNavQuote(wallet("navSigner"), deployment.contracts.mintManager, chainId, quote, "BaseMetricMintManager");
  await (await mintManager.connect(wallet("safe")).mint(intentId, usdcRequired, quote, navSig)).wait();
  return a.nettKg6dec;
}

console.log("=== redeem (commercial) ===");
const intent1 = 5001n;
const kg1 = await mintLot(intent1, 500);
await (await redeemManager.connect(wallet("recipient")).redeem(intent1, kg1)).wait();
const lot1 = await registry.getLot(intent1);
console.log("lotState after redeem:", lot1.lotState, "(expect 2 = Redeemed)");

console.log("\n=== finalRelease ===");
const f = { intentId: intent1, timestamp: await nextTimestamp() };
const fSig = await signFinalReleaseAttestation(wallet("diaSigner"), deployment.contracts.adapter, chainId, f);
await (await adapter.connect(wallet("other")).finalRelease(f, fSig)).wait();
const lot1b = await registry.getLot(intent1);
console.log("reserveReleased:", lot1b.reserveReleased, "(expect true)");

console.log("\n=== revoke (2-of-3) ===");
const intent2 = 5002n;
const a2 = {
  warehouseId: BigInt(deployment.warehouseId),
  intentId: intent2,
  lotId: intent2,
  receiptNumber: intent2,
  commodity: "lead",
  nettKg6dec: 10_000_000n,
  allowanceRecipient: recipient,
  timestamp: await nextTimestamp(),
};
const sig2 = await signLotAttestation(wallet("diaSigner"), deployment.contracts.adapter, chainId, a2);
await (await adapter.connect(wallet("other")).postAttestation(a2, sig2)).wait();

const reserveBefore = await registry.getReserve();
const r = { intentId: intent2, timestamp: await nextTimestamp() };
const rSig1 = await signRevokeAttestation(wallet("revoke1"), deployment.contracts.adapter, chainId, r);
const rSig2 = await signRevokeAttestation(wallet("revoke2"), deployment.contracts.adapter, chainId, r);
await (await adapter.connect(wallet("other")).revoke(r, [rSig1, rSig2, "0x"])).wait();
const reserveAfter = await registry.getReserve();
console.log("reserve before:", ethers.formatUnits(reserveBefore, 6), "after revoke:", ethers.formatUnits(reserveAfter, 6));
const [, , state] = await registry.allowanceOf(intent2);
console.log("allowanceState:", state, "(expect 3 = Revoked)");

console.log("\n=== redeemCeremony ===");
const intent3 = 5003n;
const kg3 = await mintLot(intent3, 200);
await (await redeemManager.connect(wallet("deployer")).setCeremonyEnabled(true)).wait();
const navPrice3 = 2_000_000n;
const quote3 = { navPriceUsdc6PerKg: navPrice3, validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: 999n };
const navSig3 = await signNavQuote(wallet("navSigner"), deployment.contracts.redeemManager, chainId, quote3, "BaseMetricRedeemManager");
const treasuryBefore = await provider.getBalance ? null : null; // n/a
await (await redeemManager.connect(wallet("recipient")).redeemCeremony(intent3, kg3, quote3, navSig3)).wait();
const balAfter = await usdc.balanceOf(recipient);
console.log("recipient USDC balance after ceremony payout:", ethers.formatUnits(balAfter, 6));

console.log("\nSMOKE TEST 2 OK");
