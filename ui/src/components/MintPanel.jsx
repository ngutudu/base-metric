import { useState } from "react";
import { getContract, getSigner, parseUsdc, nowSeconds, CHAIN_ID, ROLES } from "../chain";
import { signNavQuote } from "../eip712";
import { runTx } from "../runTx";

const field = { display: "block", width: "100%", margin: "4px 0 10px", padding: 6 };

export default function MintPanel({ log }) {
  const [intentId, setIntentId] = useState("1001");
  const [navPrice, setNavPrice] = useState("2.4837");
  const [usdcAmount, setUsdcAmount] = useState(""); // leave blank to auto-compute
  const [nonce, setNonce] = useState(String(Date.now()));

  async function fundSafe() {
    const usdc = getContract("usdc", getSigner("deployer"));
    await runTx(log, "mint 1,000,000 USDC to safe (test faucet)", () =>
      usdc.mint(ROLES.safe, parseUsdc(1_000_000))
    );
  }

  async function mint() {
    const registry = getContract("registry");
    const mintManager = getContract("mintManager");
    const lot = await registry.getLot(BigInt(intentId));
    const nettKg6dec = lot.nettKg6dec;
    const navPrice6dec = BigInt(Math.round(parseFloat(navPrice) * 1e6));
    const required = (nettKg6dec * navPrice6dec) / 1_000_000n;
    const usdcToSend = usdcAmount ? parseUsdc(usdcAmount) : required;

    const quote = {
      navPriceUsdc6PerKg: navPrice6dec,
      validUntil: BigInt(nowSeconds() + 3600),
      nonce: BigInt(nonce),
    };

    await runTx(log, `mint(intentId=${intentId}, usdc≈${(Number(usdcToSend) / 1e6).toFixed(2)})`, async () => {
      const sig = await signNavQuote(
        getSigner("navSigner"),
        await mintManager.getAddress(),
        CHAIN_ID,
        quote,
        "BaseMetricMintManager"
      );
      const safe = getSigner("safe");
      const usdc = getContract("usdc", safe);
      await (await usdc.approve(await mintManager.getAddress(), usdcToSend)).wait();
      return mintManager.connect(safe).mint(BigInt(intentId), usdcToSend, quote, sig);
    });
  }

  return (
    <div>
      <h3>Mint — triggered as "safe" (operational convention, not enforced on-chain)</h3>
      <button onClick={fundSafe}>Faucet: mint 1,000,000 USDC to safe</button>

      <h3 style={{ marginTop: 20 }}>mint()</h3>
      <label>intentId (phải đã postAttestation trước)
        <input style={field} value={intentId} onChange={(e) => setIntentId(e.target.value)} />
      </label>
      <label>NAV price (USDC/kg)
        <input style={field} value={navPrice} onChange={(e) => setNavPrice(e.target.value)} />
      </label>
      <label>usdcAmount (để trống = tự tính đúng theo công thức)
        <input style={field} placeholder="auto" value={usdcAmount} onChange={(e) => setUsdcAmount(e.target.value)} />
      </label>
      <label>nonce (NavQuote, mỗi lần nên khác)
        <input style={field} value={nonce} onChange={(e) => setNonce(e.target.value)} />
      </label>
      <button onClick={mint}>Mint</button>
    </div>
  );
}
