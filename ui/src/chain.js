import { ethers } from "ethers";
import deployment from "./deployment.json";
import { HARDHAT_ACCOUNTS } from "./accounts";
import {
  USDC_ABI,
  TOKEN_ABI,
  REGISTRY_ABI,
  ADAPTER_ABI,
  MINT_MANAGER_ABI,
  REDEEM_MANAGER_ABI,
  TREASURY_ABI,
} from "./abis";

export const CHAIN_ID = deployment.chainId;
export const WAREHOUSE_ID = BigInt(deployment.warehouseId);
export const ADDRESSES = deployment.contracts;
export const ROLES = deployment.roles;
export const isDeployed = Object.values(ADDRESSES).every((a) => a && a !== "");

let _provider;
export function getProvider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(deployment.rpcUrl, deployment.chainId);
  return _provider;
}

const _signers = new Map();
/** A signer backed by one of Hardhat's well-known local test keys. Cached per label
 * and wrapped in a NonceManager: ethers' JsonRpcProvider can return a one-tx-stale
 * nonce for "pending" when queried immediately after a prior send on a fast local
 * node, which causes spurious NONCE_EXPIRED errors on back-to-back transactions.
 * NonceManager tracks the nonce client-side instead of re-querying the RPC each time. */
export function getSigner(label) {
  if (_signers.has(label)) return _signers.get(label);
  const acc = HARDHAT_ACCOUNTS.find((a) => a.label === label);
  if (!acc) throw new Error(`Unknown signer label: ${label}`);
  const wallet = new ethers.Wallet(acc.privateKey, getProvider());
  const managed = new ethers.NonceManager(wallet);
  _signers.set(label, managed);
  return managed;
}

/** NonceManager optimistically bumps its local counter when a send is attempted,
 * and doesn't roll that back if the attempt ultimately fails (e.g. reverts, or the
 * RPC call itself errors) — causing "nonce too high" on the next real transaction.
 * Called from runTx's catch block so every failed action self-heals before the
 * next attempt, rather than requiring a page reload. */
export function resetAllSigners() {
  for (const signer of _signers.values()) signer.reset();
}

const ABI_BY_NAME = {
  usdc: USDC_ABI,
  token: TOKEN_ABI,
  registry: REGISTRY_ABI,
  adapter: ADAPTER_ABI,
  mintManager: MINT_MANAGER_ABI,
  redeemManager: REDEEM_MANAGER_ABI,
  treasury: TREASURY_ABI,
};

/** `runner` is a Signer (for writes) or the provider (for reads). */
export function getContract(name, runner = getProvider()) {
  const address = ADDRESSES[name];
  if (!address) throw new Error(`No address for contract '${name}' — run the deploy script first`);
  return new ethers.Contract(address, ABI_BY_NAME[name], runner);
}

export function fmtKg(v) {
  return ethers.formatUnits(v, 6);
}

export function parseKg(v) {
  return ethers.parseUnits(String(v || "0"), 6);
}

export function fmtUsdc(v) {
  return ethers.formatUnits(v, 6);
}

export function parseUsdc(v) {
  return ethers.parseUnits(String(v || "0"), 6);
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** The adapter requires a strictly increasing `timestamp` across all 3 attestation
 * types — two calls within the same wall-clock second otherwise collide
 * (StaleOrZeroTimestamp). Always derive the timestamp to send from this, not raw
 * nowSeconds(), for postAttestation/revoke/finalRelease. */
export async function nextAdapterTimestamp(adapterContract) {
  const last = await adapterContract.lastTimestamp();
  const now = BigInt(nowSeconds());
  return last >= now ? last + 1n : now;
}

export function labelFor(address) {
  if (!address) return "";
  const entry = Object.entries(ROLES).find(([, a]) => a?.toLowerCase() === address.toLowerCase());
  return entry ? `${entry[0]} (${address.slice(0, 6)}…)` : address;
}

export function allowanceStateName(n) {
  return ["None", "Issued", "Consumed", "Revoked"][Number(n)] ?? String(n);
}

export function lotStateName(n) {
  return ["None", "Active", "Redeemed"][Number(n)] ?? String(n);
}
