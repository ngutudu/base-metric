import { useState } from "react";
import { getContract, getSigner, WAREHOUSE_ID, nextAdapterTimestamp, CHAIN_ID } from "../chain";
import { signLotAttestation, signRevokeAttestation, signFinalReleaseAttestation } from "../eip712";
import { runTx } from "../runTx";

const field = { display: "block", width: "100%", margin: "4px 0 10px", padding: 6 };

export default function AdapterPanel({ log }) {
  const [intentId, setIntentId] = useState("1001");
  const [lotId, setLotId] = useState("501");
  const [receiptNumber, setReceiptNumber] = useState("9001");
  const [commodity, setCommodity] = useState("lead");
  const [nettKg, setNettKg] = useState("25100.437");
  const [recipient, setRecipient] = useState("");

  const [revokeIntentId, setRevokeIntentId] = useState("1001");
  const [finalIntentId, setFinalIntentId] = useState("1001");

  async function postAttestation() {
    const adapter = getContract("adapter");
    const diaSigner = getSigner("diaSigner");
    const a = {
      warehouseId: WAREHOUSE_ID,
      intentId: BigInt(intentId),
      lotId: BigInt(lotId),
      receiptNumber: BigInt(receiptNumber),
      commodity,
      nettKg6dec: BigInt(Math.round(parseFloat(nettKg) * 1e6)),
      allowanceRecipient: recipient,
      timestamp: await nextAdapterTimestamp(adapter),
    };
    await runTx(log, `postAttestation(intentId=${intentId})`, async () => {
      const sig = await signLotAttestation(diaSigner, await adapter.getAddress(), CHAIN_ID, a);
      return adapter.connect(getSigner("other")).postAttestation(a, sig);
    });
  }

  async function revoke() {
    const adapter = getContract("adapter");
    const addr = await adapter.getAddress();
    const r = { intentId: BigInt(revokeIntentId), timestamp: await nextAdapterTimestamp(adapter) };
    await runTx(log, `revoke(intentId=${revokeIntentId}) — 2-of-3`, async () => {
      const sig1 = await signRevokeAttestation(getSigner("revoke1"), addr, CHAIN_ID, r);
      const sig2 = await signRevokeAttestation(getSigner("revoke2"), addr, CHAIN_ID, r);
      return adapter.connect(getSigner("other")).revoke(r, [sig1, sig2, "0x"]);
    });
  }

  async function finalRelease() {
    const adapter = getContract("adapter");
    const addr = await adapter.getAddress();
    const f = { intentId: BigInt(finalIntentId), timestamp: await nextAdapterTimestamp(adapter) };
    await runTx(log, `finalRelease(intentId=${finalIntentId})`, async () => {
      const sig = await signFinalReleaseAttestation(getSigner("diaSigner"), addr, CHAIN_ID, f);
      return adapter.connect(getSigner("other")).finalRelease(f, sig);
    });
  }

  async function togglePause(pause) {
    const adapter = getContract("adapter", getSigner("deployer"));
    await runTx(log, pause ? "adapter.pause()" : "adapter.unpause()", () =>
      pause ? adapter.pause() : adapter.unpause()
    );
  }

  return (
    <div>
      <h3>1 · DIA attestation (postAttestation) — signed by diaSigner</h3>
      <label>intentId<input style={field} value={intentId} onChange={(e) => setIntentId(e.target.value)} /></label>
      <label>lotId<input style={field} value={lotId} onChange={(e) => setLotId(e.target.value)} /></label>
      <label>receiptNumber<input style={field} value={receiptNumber} onChange={(e) => setReceiptNumber(e.target.value)} /></label>
      <label>commodity<input style={field} value={commodity} onChange={(e) => setCommodity(e.target.value)} /></label>
      <label>nettKg<input style={field} value={nettKg} onChange={(e) => setNettKg(e.target.value)} /></label>
      <label>allowanceRecipient (ví được phép mint)
        <input style={field} placeholder="0x... (vd ROLES.recipient)" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
      </label>
      <button onClick={postAttestation}>Post LotAttestation</button>

      <h3 style={{ marginTop: 24 }}>2 · Revoke (2-of-3: revoke1 + revoke2)</h3>
      <label>intentId<input style={field} value={revokeIntentId} onChange={(e) => setRevokeIntentId(e.target.value)} /></label>
      <button onClick={revoke}>Revoke allowance</button>

      <h3 style={{ marginTop: 24 }}>3 · Final Release (after redeem — signed by diaSigner)</h3>
      <label>intentId<input style={field} value={finalIntentId} onChange={(e) => setFinalIntentId(e.target.value)} /></label>
      <button onClick={finalRelease}>finalRelease (reserve deducts here)</button>

      <h3 style={{ marginTop: 24 }}>4 · Emergency pause (adapter owner = deployer)</h3>
      <button onClick={() => togglePause(true)}>Pause adapter</button>{" "}
      <button onClick={() => togglePause(false)}>Unpause adapter</button>
    </div>
  );
}
