import { useState } from "react";
import { getContract, getSigner, nowSeconds, CHAIN_ID } from "../chain";
import { signNavQuote } from "../eip712";
import { runTx } from "../runTx";

const field = { display: "block", width: "100%", margin: "4px 0 10px", padding: 6 };

export default function RedeemPanel({ log }) {
  const [intentId, setIntentId] = useState("1001");
  const [asAccount, setAsAccount] = useState("recipient");
  const [navPrice, setNavPrice] = useState("2.4837");
  const [nonce, setNonce] = useState(String(Date.now()));

  async function enableCeremony() {
    const redeemManager = getContract("redeemManager", getSigner("deployer"));
    await runTx(log, "setCeremonyEnabled(true)", () => redeemManager.setCeremonyEnabled(true));
  }

  async function redeem() {
    const registry = getContract("registry");
    const redeemManager = getContract("redeemManager", getSigner(asAccount));
    const lot = await registry.getLot(BigInt(intentId));
    await runTx(log, `redeem(intentId=${intentId}) — commercial, no payout`, () =>
      redeemManager.redeem(BigInt(intentId), lot.nettKg6dec)
    );
  }

  async function redeemCeremony() {
    const registry = getContract("registry");
    const redeemManager = getContract("redeemManager", getSigner(asAccount));
    const lot = await registry.getLot(BigInt(intentId));
    const navPrice6dec = BigInt(Math.round(parseFloat(navPrice) * 1e6));
    const quote = {
      navPriceUsdc6PerKg: navPrice6dec,
      validUntil: BigInt(nowSeconds() + 3600),
      nonce: BigInt(nonce),
    };
    await runTx(log, `redeemCeremony(intentId=${intentId}) — atomic payout`, async () => {
      const sig = await signNavQuote(
        getSigner("navSigner"),
        await redeemManager.getAddress(),
        CHAIN_ID,
        quote,
        "BaseMetricRedeemManager"
      );
      return redeemManager.redeemCeremony(BigInt(intentId), lot.nettKg6dec, quote, sig);
    });
  }

  return (
    <div>
      <h3>Redeem</h3>
      <label>intentId (phải đã mint/Consumed trước)
        <input style={field} value={intentId} onChange={(e) => setIntentId(e.target.value)} />
      </label>
      <label>Gọi với tư cách (phải là người đang giữ token của lô này)
        <select style={field} value={asAccount} onChange={(e) => setAsAccount(e.target.value)}>
          <option value="recipient">recipient</option>
          <option value="other">other</option>
          <option value="safe">safe</option>
        </select>
      </label>

      <button onClick={redeem}>redeem() — chỉ đốt, không trả USDC</button>

      <h4 style={{ marginTop: 20 }}>Ceremony (Phase 0 demo — đốt + trả USDC atomic)</h4>
      <button onClick={enableCeremony}>setCeremonyEnabled(true)</button>
      <label>NAV price lúc redeem (USDC/kg)
        <input style={field} value={navPrice} onChange={(e) => setNavPrice(e.target.value)} />
      </label>
      <label>nonce
        <input style={field} value={nonce} onChange={(e) => setNonce(e.target.value)} />
      </label>
      <button onClick={redeemCeremony}>redeemCeremony()</button>
    </div>
  );
}
