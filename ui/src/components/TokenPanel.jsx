import { useState } from "react";
import { getContract, getSigner, fmtKg, ROLES, labelFor } from "../chain";
import { runTx } from "../runTx";

const field = { display: "block", width: "100%", margin: "4px 0 10px", padding: 6 };
const pre = { background: "#f5f5f5", padding: 10, whiteSpace: "pre-wrap", fontSize: 13 };

export default function TokenPanel({ log }) {
  const [address, setAddress] = useState(ROLES.recipient || "");
  const [balance, setBalance] = useState(null);
  const [allowlistAddr, setAllowlistAddr] = useState(ROLES.recipient || "");

  async function checkBalance() {
    const token = getContract("token");
    const bal = await token.balanceOf(address);
    const total = await token.totalSupply();
    setBalance({ bal: fmtKg(bal), total: fmtKg(total) });
  }

  async function allow(flag) {
    const token = getContract("token", getSigner("deployer"));
    await runTx(log, `setAllowlist(${labelFor(allowlistAddr)}, ${flag})`, () =>
      token.setAllowlist(allowlistAddr, flag)
    );
  }

  return (
    <div>
      <h3>BMTokenPOC</h3>
      <label>Địa chỉ cần xem balance
        <input style={field} value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      <button onClick={checkBalance}>balanceOf</button>
      {balance && <pre style={pre}>{`balance: ${balance.bal} bmLEAD\ntotalSupply: ${balance.total} bmLEAD`}</pre>}

      <h4 style={{ marginTop: 20 }}>Allowlist (bắt buộc trước khi mint cho 1 ví)</h4>
      <label>Địa chỉ
        <input style={field} value={allowlistAddr} onChange={(e) => setAllowlistAddr(e.target.value)} />
      </label>
      <button onClick={() => allow(true)}>Allowlist ON</button>{" "}
      <button onClick={() => allow(false)}>Allowlist OFF</button>

      <h4 style={{ marginTop: 20 }}>Known role addresses</h4>
      <pre style={pre}>{Object.entries(ROLES).map(([k, v]) => `${k}: ${v}`).join("\n")}</pre>
    </div>
  );
}
