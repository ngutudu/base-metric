import { resetAllSigners } from "./chain";

/** Pulls the human-readable revert reason out of an ethers v6 error. Our own ABI
 * fragments don't declare `error` entries, so ethers can't decode custom errors
 * itself — but Hardhat's node already decodes them server-side and embeds the name
 * in the nested JSON-RPC error message (e.g. "...reverted with custom error
 * 'ERC20InsufficientBalance(...)'"). Prefer that over ethers' own generic
 * "unknown custom error". */
function describeError(err) {
  const nodeMsg = err?.info?.error?.message || err?.error?.message;
  const match = typeof nodeMsg === "string" && nodeMsg.match(/custom error '([^']+)'/);
  if (match) return match[1];
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

/** Runs an async action, logs start/success/error consistently. `fn` may return a
 * tx (with .wait()) or a plain value (for read calls). */
export async function runTx(log, description, fn) {
  log(`→ ${description}…`, "pending");
  try {
    const result = await fn();
    if (result && typeof result.wait === "function") {
      const receipt = await result.wait();
      log(`✓ ${description} — tx ${receipt.hash.slice(0, 10)}…`, "ok");
      return receipt;
    }
    log(`✓ ${description}`, "ok");
    return result;
  } catch (err) {
    resetAllSigners(); // undo any optimistic nonce bump from this failed attempt
    log(`✗ ${description} — ${describeError(err)}`, "err");
    throw err;
  }
}
