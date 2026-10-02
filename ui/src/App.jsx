import { useState } from "react";
import { isDeployed, ROLES } from "./chain";
import AdapterPanel from "./components/AdapterPanel";
import MintPanel from "./components/MintPanel";
import RedeemPanel from "./components/RedeemPanel";
import RegistryViewer from "./components/RegistryViewer";
import TokenPanel from "./components/TokenPanel";
import AdminPanel from "./components/AdminPanel";

const TABS = [
  { key: "adapter", label: "1 · DIA Attestation", Comp: AdapterPanel },
  { key: "mint", label: "2 · Mint", Comp: MintPanel },
  { key: "redeem", label: "3 · Redeem", Comp: RedeemPanel },
  { key: "registry", label: "4 · Registry (read)", Comp: RegistryViewer },
  { key: "token", label: "5 · Token / Allowlist", Comp: TokenPanel },
  { key: "admin", label: "6 · Treasury / Pause", Comp: AdminPanel },
];

export default function App() {
  const [tab, setTab] = useState("adapter");
  const [logs, setLogs] = useState([]);

  function log(msg, kind = "info") {
    setLogs((prev) => [{ msg, kind, t: new Date().toLocaleTimeString() }, ...prev].slice(0, 200));
  }

  if (!isDeployed) {
    return (
      <div style={{ fontFamily: "monospace", padding: 40, maxWidth: 700 }}>
        <h2>Chưa có deployment</h2>
        <p>
          Chạy node local rồi deploy để tự sinh file cấu hình cho UI:
        </p>
        <pre style={{ background: "#f5f5f5", padding: 12 }}>
          {`npx hardhat node
# cửa sổ khác:
npx hardhat run scripts/deploy.js --network localhost`}
        </pre>
        <p>Script sẽ tự ghi <code>ui/src/deployment.json</code> — reload lại trang này sau khi deploy xong.</p>
      </div>
    );
  }

  const Active = TABS.find((t) => t.key === tab).Comp;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", display: "flex", height: "100vh" }}>
      <div style={{ flex: "0 0 220px", borderRight: "1px solid #ddd", padding: 16, overflowY: "auto" }}>
        <h2 style={{ fontSize: 16 }}>BaseMetric — test console</h2>
        <p style={{ fontSize: 12, color: "#888" }}>Local Hardhat node only. Không dùng key thật.</p>
        {TABS.map((t) => (
          <div
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "8px 10px",
              cursor: "pointer",
              borderRadius: 6,
              marginBottom: 4,
              background: tab === t.key ? "#2563eb" : "transparent",
              color: tab === t.key ? "#fff" : "#111",
              fontSize: 14,
            }}
          >
            {t.label}
          </div>
        ))}
        <details style={{ marginTop: 20, fontSize: 11 }}>
          <summary>Role addresses</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {Object.entries(ROLES).map(([k, v]) => `${k}\n  ${v}\n`).join("")}
          </pre>
        </details>
      </div>

      <div style={{ flex: 1, padding: 24, overflowY: "auto" }}>
        <Active log={log} />
      </div>

      <div style={{ flex: "0 0 380px", borderLeft: "1px solid #ddd", padding: 16, overflowY: "auto", background: "#fafafa" }}>
        <h3 style={{ fontSize: 14 }}>Log</h3>
        {logs.map((l, i) => (
          <div
            key={i}
            style={{
              fontSize: 12,
              fontFamily: "monospace",
              padding: "4px 0",
              borderBottom: "1px solid #eee",
              color: l.kind === "err" ? "crimson" : l.kind === "ok" ? "#047857" : "#333",
            }}
          >
            [{l.t}] {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
