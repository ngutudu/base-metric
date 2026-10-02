import { useState } from "react";
import { getContract, WAREHOUSE_ID, fmtKg, allowanceStateName, lotStateName, labelFor } from "../chain";

const field = { display: "block", width: "100%", margin: "4px 0 10px", padding: 6 };
const pre = { background: "#f5f5f5", padding: 10, whiteSpace: "pre-wrap", fontSize: 13 };

export default function RegistryViewer() {
  const [intentId, setIntentId] = useState("1001");
  const [lot, setLot] = useState(null);
  const [reserve, setReserve] = useState(null);
  const [fifo, setFifo] = useState(null);
  const [stale, setStale] = useState(null);
  const [error, setError] = useState("");

  async function loadLot() {
    setError("");
    try {
      const registry = getContract("registry");
      const l = await registry.getLot(BigInt(intentId));
      setLot(l);
    } catch (e) {
      setLot(null);
      setError(e?.shortMessage || e?.message || String(e));
    }
  }

  async function loadReserve() {
    const registry = getContract("registry");
    const total = await registry.getReserve();
    const perWarehouse = await registry.getReserve(WAREHOUSE_ID);
    const isStale = await registry.isStale(WAREHOUSE_ID);
    setReserve({ total: fmtKg(total), perWarehouse: fmtKg(perWarehouse) });
    setStale(isStale);
  }

  async function loadFifo() {
    const registry = getContract("registry");
    const [id, found] = await registry.nextLotFIFO(WAREHOUSE_ID);
    setFifo(found ? id.toString() : "(none)");
  }

  return (
    <div>
      <h3>Reserve</h3>
      <button onClick={loadReserve}>Load reserve</button>
      {reserve && (
        <pre style={pre}>
          {`total reserve (all warehouses): ${reserve.total} kg
warehouse ${WAREHOUSE_ID}: ${reserve.perWarehouse} kg
isStale: ${stale}`}
        </pre>
      )}

      <h3 style={{ marginTop: 20 }}>Next redeemable lot (FIFO)</h3>
      <button onClick={loadFifo}>nextLotFIFO</button>
      {fifo !== null && <pre style={pre}>{fifo}</pre>}

      <h3 style={{ marginTop: 20 }}>Lot lookup</h3>
      <label>intentId<input style={field} value={intentId} onChange={(e) => setIntentId(e.target.value)} /></label>
      <button onClick={loadLot}>getLot</button>
      {error && <pre style={{ ...pre, color: "crimson" }}>{error}</pre>}
      {lot && (
        <pre style={pre}>
          {`warehouseId: ${lot.warehouseId}
intentId: ${lot.intentId}
lotId: ${lot.lotId}
receiptNumber: ${lot.receiptNumber}
nettKg6dec: ${fmtKg(lot.nettKg6dec)} kg
commodity: ${lot.commodity}
allowanceRecipient: ${labelFor(lot.allowanceRecipient)}
allowanceState: ${allowanceStateName(lot.allowanceState)}
lotState: ${lotStateName(lot.lotState)}
reserveReleased: ${lot.reserveReleased}`}
        </pre>
      )}
    </div>
  );
}
