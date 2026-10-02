import { useState } from "react";
import { getContract, getSigner, fmtUsdc } from "../chain";
import { runTx } from "../runTx";

const pre = { background: "#f5f5f5", padding: 10, whiteSpace: "pre-wrap", fontSize: 13 };

export default function AdminPanel({ log }) {
  const [treasuryBal, setTreasuryBal] = useState(null);

  async function loadTreasury() {
    const treasury = getContract("treasury");
    const bal = await treasury.balance();
    setTreasuryBal(fmtUsdc(bal));
  }

  async function pauseAll(pause) {
    const token = getContract("token", getSigner("deployer"));
    const mintManager = getContract("mintManager", getSigner("deployer"));
    const redeemManager = getContract("redeemManager", getSigner("deployer"));
    const fn = pause ? "pause" : "unpause";
    await runTx(log, `token.${fn}()`, () => token[fn]());
    await runTx(log, `mintManager.${fn}()`, () => mintManager[fn]());
    await runTx(log, `redeemManager.${fn}()`, () => redeemManager[fn]());
  }

  return (
    <div>
      <h3>Treasury</h3>
      <button onClick={loadTreasury}>Load USDC balance</button>
      {treasuryBal !== null && <pre style={pre}>{`${treasuryBal} USDC`}</pre>}

      <h3 style={{ marginTop: 20 }}>Emergency pause — Token / MintManager / RedeemManager</h3>
      <p style={{ fontSize: 13, color: "#555" }}>
        (Adapter có nút pause riêng ở tab DIA Attestation)
      </p>
      <button onClick={() => pauseAll(true)}>Pause all 3</button>{" "}
      <button onClick={() => pauseAll(false)}>Unpause all 3</button>
    </div>
  );
}
