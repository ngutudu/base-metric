// One-off smoke test: exercises the UI's exact ABI/signing code against the live
// localhost deployment. Not part of the app; run with `node smoke-test.mjs`.
import { ethers } from "ethers";
import deployment from "./src/deployment.json" with { type: "json" };
import { HARDHAT_ACCOUNTS } from "./src/accounts.js";
import { ADAPTER_ABI, REGISTRY_ABI, MINT_MANAGER_ABI, TOKEN_ABI, USDC_ABI } from "./src/abis.js";
import { signLotAttestation, signNavQuote } from "./src/eip712.js";

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

const chainId = deployment.chainId;
const intentId = 7777n;
const recipient = deployment.roles.recipient;

const a = {
  warehouseId: BigInt(deployment.warehouseId),
  intentId,
  lotId: 1n,
  receiptNumber: 1n,
  commodity: "lead",
  nettKg6dec: 1_000_000_000n, // 1,000 kg
  allowanceRecipient: recipient,
  timestamp: BigInt(Math.floor(Date.now() / 1000)),
};

console.log("1) postAttestation...");
const sig = await signLotAttestation(wallet("diaSigner"), deployment.contracts.adapter, chainId, a);
await (await adapter.connect(wallet("other")).postAttestation(a, sig)).wait();
const lot = await registry.getLot(intentId);
console.log("   lot recorded, nettKg6dec =", lot.nettKg6dec.toString(), "allowanceState =", lot.allowanceState);

console.log("2) allowlist recipient...");
await (await token.setAllowlist(recipient, true)).wait();

console.log("3) mint...");
const navPrice = 2_000_000n; // $2/kg
const usdcRequired = (a.nettKg6dec * navPrice) / 1_000_000n;
await (await usdc.mint(deployment.roles.safe, usdcRequired)).wait();
await (await usdc.connect(wallet("safe")).approve(deployment.contracts.mintManager, usdcRequired)).wait();
const quote = { navPriceUsdc6PerKg: navPrice, validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: 42n };
const navSig = await signNavQuote(wallet("navSigner"), deployment.contracts.mintManager, chainId, quote, "BaseMetricMintManager");
await (await mintManager.connect(wallet("safe")).mint(intentId, usdcRequired, quote, navSig)).wait();

const balance = await token.balanceOf(recipient);
console.log("   minted. recipient balance =", ethers.formatUnits(balance, 6), "bmLEAD");

console.log("SMOKE TEST OK");
