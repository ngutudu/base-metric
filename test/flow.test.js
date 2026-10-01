const { expect } = require("chai");
const { ethers } = require("hardhat");

const WAREHOUSE_ID = 1n; // integer ids per DIA (30 Sep) — Steinweg = 1
const MAX_DRIFT = 10_000n; // $0.01 in 6dp base units (§H)

async function adapterDomain(adapter) {
  return {
    name: "BaseMetricPoR",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await adapter.getAddress(),
  };
}

async function signLotAttestation(adapter, signer, a) {
  const domain = await adapterDomain(adapter);
  const types = {
    LotAttestation: [
      { name: "warehouseId", type: "uint256" },
      { name: "intentId", type: "uint256" },
      { name: "lotId", type: "uint256" },
      { name: "receiptNumber", type: "uint256" },
      { name: "commodity", type: "string" },
      { name: "nettKg6dec", type: "uint256" },
      { name: "allowanceRecipient", type: "address" },
      { name: "timestamp", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, a);
}

async function signRevokeAttestation(adapter, signer, r) {
  const domain = await adapterDomain(adapter);
  const types = {
    RevokeAttestation: [
      { name: "intentId", type: "uint256" },
      { name: "timestamp", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, r);
}

/// Builds the 3-slot signature array `revoke()` expects, matching `revokeSigners`
/// index-for-index. Pass a signer (or null to leave that slot empty, "0x").
async function signRevokeTuple(adapter, r, [signerA, signerB, signerC]) {
  const sign = async (s) => (s ? signRevokeAttestation(adapter, s, r) : "0x");
  return Promise.all([sign(signerA), sign(signerB), sign(signerC)]);
}

async function signFinalReleaseAttestation(adapter, signer, f) {
  const domain = await adapterDomain(adapter);
  const types = {
    FinalReleaseAttestation: [
      { name: "intentId", type: "uint256" },
      { name: "timestamp", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, f);
}

async function signNavQuote(target, navSigner, quote, domainName = "BaseMetricMintManager") {
  const domain = {
    name: domainName,
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await target.getAddress(),
  };
  const types = {
    NavQuote: [
      { name: "navPriceUsdc6PerKg", type: "uint256" },
      { name: "validUntil", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };
  return navSigner.signTypedData(domain, types, quote);
}

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function deployFixture() {
  const [deployer, navSigner, diaSigner, multisig, safe, recipient, other, revoke1, revoke2, revoke3] =
    await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const registry = await (await ethers.getContractFactory("BasemetricRegistry")).deploy();
  const token = await (await ethers.getContractFactory("BMTokenPOC")).deploy("BaseMetric Lead POC", "bmLEAD");
  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(
    await usdc.getAddress(),
    deployer.address
  );
  const adapter = await (await ethers.getContractFactory("WarrantPoRAdapter")).deploy(
    WAREHOUSE_ID,
    diaSigner.address,
    await registry.getAddress()
  );
  const mintManager = await (await ethers.getContractFactory("MintManager")).deploy(
    await token.getAddress(),
    await treasury.getAddress(),
    await registry.getAddress(),
    await usdc.getAddress(),
    navSigner.address,
    MAX_DRIFT
  );
  const redeemManager = await (await ethers.getContractFactory("RedeemManager")).deploy(
    await token.getAddress(),
    await treasury.getAddress(),
    await registry.getAddress(),
    navSigner.address
  );

  await token.setMintManager(await mintManager.getAddress());
  await token.setRedeemManager(await redeemManager.getAddress());
  await treasury.setMintManager(await mintManager.getAddress());
  await treasury.setRedeemManager(await redeemManager.getAddress());
  await registry.setRedeemManager(await redeemManager.getAddress());
  await adapter.setMintManager(await mintManager.getAddress());
  await adapter.setRevokeSigners([revoke1.address, revoke2.address, revoke3.address]);
  await registry.registerWarehouse(WAREHOUSE_ID, await adapter.getAddress());

  return {
    deployer, navSigner, diaSigner, multisig, safe, recipient, other, revoke1, revoke2, revoke3,
    usdc, registry, token, treasury, adapter, mintManager, redeemManager,
  };
}

describe("BaseMetric Phase 0 flow (push + verify-signature, single-key, integer ids)", function () {
  const INTENT_1 = 1001n;
  const LOT_1 = 501n;
  const RECEIPT_1 = 9001n;
  const NETT_KG = 25_100_437_000n; // 25,100.437 kg, 6dp (§H worked example)
  const NAV_PRICE = 2_483_700n; // $2.4837 /kg
  const USDC_REQUIRED = (NETT_KG * NAV_PRICE) / 1_000_000n; // 62,341,955,376

  async function postLot(f, { intentId = INTENT_1, recipient, timestamp } = {}) {
    const a = {
      warehouseId: WAREHOUSE_ID,
      intentId,
      lotId: LOT_1,
      receiptNumber: RECEIPT_1,
      commodity: "lead",
      nettKg6dec: NETT_KG,
      allowanceRecipient: recipient,
      timestamp: timestamp ?? (await now()),
    };
    const sig = await signLotAttestation(f.adapter, f.diaSigner, a);
    await f.adapter.postAttestation(a, sig);
    return a;
  }

  async function mintedFixture() {
    const f = await deployFixture();
    await postLot(f, { recipient: f.recipient.address });
    await f.token.setAllowlist(f.recipient.address, true);

    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await f.mintManager.connect(f.safe).mint(INTENT_1, USDC_REQUIRED, quote, sig);
    return f;
  }

  it("verifies DIA's signed attestation and records the lot + allowance", async function () {
    const f = await deployFixture();
    await postLot(f, { recipient: f.recipient.address });
    const lot = await f.registry.getLot(INTENT_1);
    expect(lot.nettKg6dec).to.equal(NETT_KG);
    expect(lot.lotId).to.equal(LOT_1);
    expect(lot.receiptNumber).to.equal(RECEIPT_1);
    expect(lot.allowanceRecipient).to.equal(f.recipient.address);
    expect(lot.allowanceState).to.equal(1); // Issued
    expect(await f.registry.getReserve()).to.equal(NETT_KG); // reserve auto-derived
  });

  it("rejects an attestation not signed by the registered DIA key", async function () {
    const f = await deployFixture();
    const a = {
      warehouseId: WAREHOUSE_ID,
      intentId: INTENT_1,
      lotId: LOT_1,
      receiptNumber: RECEIPT_1,
      commodity: "lead",
      nettKg6dec: NETT_KG,
      allowanceRecipient: f.recipient.address,
      timestamp: await now(),
    };
    const badSig = await signLotAttestation(f.adapter, f.deployer, a); // wrong signer
    await expect(f.adapter.postAttestation(a, badSig)).to.be.revertedWithCustomError(f.adapter, "BadSigner");
  });

  it("rejects a replayed / non-increasing timestamp", async function () {
    const f = await deployFixture();
    const t = await now();
    await postLot(f, { recipient: f.recipient.address, timestamp: t });
    await expect(
      postLot(f, { intentId: INTENT_1 + 1n, recipient: f.recipient.address, timestamp: t })
    ).to.be.revertedWithCustomError(f.adapter, "StaleOrZeroTimestamp");
  });

  it("rejects an attestation older than the freshness window", async function () {
    const f = await deployFixture();
    const stale = (await now()) - 25 * 3600; // > default 24h maxAttestationAge
    await expect(postLot(f, { recipient: f.recipient.address, timestamp: stale })).to.be.revertedWithCustomError(
      f.adapter,
      "AttestationTooOld"
    );
  });

  it("mints the attested weight and routes USDC to Treasury", async function () {
    const f = await mintedFixture();
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(NETT_KG);
    expect(await f.token.totalSupply()).to.equal(NETT_KG);
    expect(await f.treasury.balance()).to.equal(USDC_REQUIRED);
    const [, , state] = await f.registry.allowanceOf(INTENT_1);
    expect(state).to.equal(2); // Consumed
  });

  it("blocks a second mint against a consumed allowance", async function () {
    const f = await mintedFixture();
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 2 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await expect(
      f.mintManager.connect(f.safe).mint(INTENT_1, USDC_REQUIRED, quote, sig)
    ).to.be.revertedWithCustomError(f.mintManager, "NoIssuedAllowance");
  });

  it("reverts a mint whose USDC drifts beyond MAX_SETTLEMENT_DRIFT", async function () {
    const f = await deployFixture();
    await postLot(f, { recipient: f.recipient.address });
    await f.token.setAllowlist(f.recipient.address, true);
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    const bad = USDC_REQUIRED + 1_000_000n;
    await f.usdc.mint(f.safe.address, bad);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), bad);
    await expect(
      f.mintManager.connect(f.safe).mint(INTENT_1, bad, quote, sig)
    ).to.be.revertedWithCustomError(f.mintManager, "SettlementDriftTooLarge");
  });

  it("reverts a mint to a de-whitelisted recipient", async function () {
    const f = await deployFixture();
    await postLot(f, { recipient: f.recipient.address }); // not allowlisted
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await expect(
      f.mintManager.connect(f.safe).mint(INTENT_1, USDC_REQUIRED, quote, sig)
    ).to.be.revertedWithCustomError(f.mintManager, "RecipientNotAllowlisted");
  });

  it("revokes an unconsumed allowance with 2-of-3 signatures", async function () {
    const f = await deployFixture();
    const t0 = await now();
    await postLot(f, { recipient: f.recipient.address, timestamp: t0 });
    const r = { intentId: INTENT_1, timestamp: t0 + 1 };
    const sigs = await signRevokeTuple(f.adapter, r, [f.revoke1, f.revoke2, null]);
    await f.adapter.revoke(r, sigs);
    const [, , state] = await f.registry.allowanceOf(INTENT_1);
    expect(state).to.equal(3); // Revoked
  });

  it("rejects a revoke with only 1 valid signature", async function () {
    const f = await deployFixture();
    const t0 = await now();
    await postLot(f, { recipient: f.recipient.address, timestamp: t0 });
    const r = { intentId: INTENT_1, timestamp: t0 + 1 };
    const sigs = await signRevokeTuple(f.adapter, r, [f.revoke1, null, null]);
    await expect(f.adapter.revoke(r, sigs)).to.be.revertedWithCustomError(f.adapter, "InsufficientRevokeSignatures");
  });

  it("revoke reverses the reserve it added at issuance (no permanent inflation)", async function () {
    const f = await deployFixture();
    const t0 = await now();
    await postLot(f, { recipient: f.recipient.address, timestamp: t0 });
    expect(await f.registry.getReserve()).to.equal(NETT_KG);

    const r = { intentId: INTENT_1, timestamp: t0 + 1 };
    await f.adapter.revoke(r, await signRevokeTuple(f.adapter, r, [null, f.revoke2, f.revoke3]));
    expect(await f.registry.getReserve()).to.equal(0);
  });

  it("re-attesting the same physical lot under a new intentId after a revoke adds the weight back exactly once", async function () {
    const f = await deployFixture();
    const t0 = await now();
    await postLot(f, { recipient: f.recipient.address, timestamp: t0 }); // intentId INTENT_1, lotId LOT_1

    const r = { intentId: INTENT_1, timestamp: t0 + 1 };
    await f.adapter.revoke(r, await signRevokeTuple(f.adapter, r, [f.revoke1, null, f.revoke3]));
    expect(await f.registry.getReserve()).to.equal(0);

    // DIA corrects the mistake and re-issues under a new intentId for the same lotId
    const INTENT_2 = 1004n;
    const a2 = {
      warehouseId: WAREHOUSE_ID,
      intentId: INTENT_2,
      lotId: LOT_1, // same physical lot
      receiptNumber: RECEIPT_1,
      commodity: "lead",
      nettKg6dec: NETT_KG,
      allowanceRecipient: f.recipient.address,
      timestamp: t0 + 2,
    };
    await f.adapter.postAttestation(a2, await signLotAttestation(f.adapter, f.diaSigner, a2));

    expect(await f.registry.getReserve()).to.equal(NETT_KG); // counted once, not twice
  });

  it("rejects a revoke slot signed by someone not in the revoke signer set", async function () {
    const f = await deployFixture();
    const t0 = await now();
    await postLot(f, { recipient: f.recipient.address, timestamp: t0 });
    const r = { intentId: INTENT_1, timestamp: t0 + 1 };
    // f.deployer is not revoke1/2/3 — occupying a slot with it must be rejected,
    // even though the OTHER slot carries a genuinely valid signature
    const sigs = await signRevokeTuple(f.adapter, r, [f.deployer, f.revoke2, null]);
    await expect(f.adapter.revoke(r, sigs)).to.be.revertedWithCustomError(
      f.adapter,
      "DuplicateOrUnknownRevokeSigner"
    );
  });

  it("blocks a mint once the allowance has been revoked (race resolved by tx order)", async function () {
    const f = await deployFixture();
    const t0 = await now();
    await postLot(f, { recipient: f.recipient.address, timestamp: t0 });
    await f.token.setAllowlist(f.recipient.address, true);
    const r = { intentId: INTENT_1, timestamp: t0 + 1 };
    const sigs = await signRevokeTuple(f.adapter, r, [f.revoke1, f.revoke2, null]);
    await f.adapter.revoke(r, sigs);

    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
    const navSig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await expect(
      f.mintManager.connect(f.safe).mint(INTENT_1, USDC_REQUIRED, quote, navSig)
    ).to.be.revertedWithCustomError(f.mintManager, "NoIssuedAllowance");
  });

  it("ceremony redemption burns the lot and pays USDC (payout derived from NAV)", async function () {
    const f = await mintedFixture();
    await f.redeemManager.setCeremonyEnabled(true);
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 99 };
    const sig = await signNavQuote(f.redeemManager, f.navSigner, quote, "BaseMetricRedeemManager");
    await expect(
      f.redeemManager.connect(f.recipient).redeemCeremony(INTENT_1, NETT_KG, quote, sig)
    ).to.emit(f.redeemManager, "CeremonySettled");
    expect(await f.token.totalSupply()).to.equal(0);
    expect(await f.treasury.balance()).to.equal(0);
  });

  it("commercial redemption burns the lot with no Treasury withdrawal", async function () {
    const f = await mintedFixture();
    await f.redeemManager.connect(f.recipient).redeem(INTENT_1, NETT_KG);
    expect(await f.token.totalSupply()).to.equal(0);
    expect(await f.treasury.balance()).to.equal(USDC_REQUIRED);
    expect((await f.registry.getLot(INTENT_1)).lotState).to.equal(2); // Redeemed
  });

  it("rejects a partial-lot redemption", async function () {
    const f = await mintedFixture();
    await expect(
      f.redeemManager.connect(f.recipient).redeem(INTENT_1, NETT_KG - 1n)
    ).to.be.revertedWithCustomError(f.redeemManager, "NotWholeLot");
  });

  it("burn does not deduct the reserve until DIA attests the Final Release Document", async function () {
    const f = await mintedFixture();
    await f.redeemManager.connect(f.recipient).redeem(INTENT_1, NETT_KG);
    expect(await f.registry.getReserve()).to.equal(NETT_KG); // still above supply
    expect(await f.token.totalSupply()).to.equal(0);

    const fr = { intentId: INTENT_1, timestamp: await now() };
    const sig = await signFinalReleaseAttestation(f.adapter, f.diaSigner, fr);
    await f.adapter.finalRelease(fr, sig);
    expect(await f.registry.getReserve()).to.equal(0);
    expect((await f.registry.getLot(INTENT_1)).reserveReleased).to.equal(true);
  });

  it("rejects a second finalRelease for the same lot", async function () {
    const f = await mintedFixture();
    await f.redeemManager.connect(f.recipient).redeem(INTENT_1, NETT_KG);
    const fr = { intentId: INTENT_1, timestamp: await now() };
    const sig = await signFinalReleaseAttestation(f.adapter, f.diaSigner, fr);
    await f.adapter.finalRelease(fr, sig);

    const fr2 = { intentId: INTENT_1, timestamp: await now() };
    const sig2 = await signFinalReleaseAttestation(f.adapter, f.diaSigner, fr2);
    await expect(f.adapter.finalRelease(fr2, sig2)).to.be.revertedWithCustomError(
      f.registry,
      "ReserveAlreadyReleased"
    );
  });

  it("rejects finalRelease before the lot has been redeemed", async function () {
    const f = await mintedFixture(); // minted but not redeemed
    const fr = { intentId: INTENT_1, timestamp: await now() };
    const sig = await signFinalReleaseAttestation(f.adapter, f.diaSigner, fr);
    await expect(f.adapter.finalRelease(fr, sig)).to.be.revertedWithCustomError(f.registry, "LotNotRedeemedYet");
  });

  it("rejects redeeming a never-minted lot using unrelated (fungible) tokens", async function () {
    const f = await mintedFixture(); // INTENT_1 minted to recipient
    // recipient moves their real tokens to `other` (allowed: sender is allowlisted)
    await f.token.connect(f.recipient).transfer(f.other.address, NETT_KG);

    // a second, legitimate lot exists but was never minted (still Issued)
    const INTENT_2 = 1002n;
    const a2 = {
      warehouseId: WAREHOUSE_ID,
      intentId: INTENT_2,
      lotId: LOT_1 + 1n,
      receiptNumber: RECEIPT_1 + 1n,
      commodity: "lead",
      nettKg6dec: NETT_KG,
      allowanceRecipient: f.recipient.address,
      timestamp: await now(),
    };
    await f.adapter.postAttestation(a2, await signLotAttestation(f.adapter, f.diaSigner, a2));

    // `other` tries to "redeem" INTENT_2 using tokens that actually came from INTENT_1
    await expect(
      f.redeemManager.connect(f.other).redeem(INTENT_2, NETT_KG)
    ).to.be.revertedWithCustomError(f.redeemManager, "LotNotMinted");

    // INTENT_2's allowance must still be mintable afterwards — untouched by the attempt
    const [, , state] = await f.registry.allowanceOf(INTENT_2);
    expect(state).to.equal(1); // still Issued
  });

  it("rejects redeeming a revoked (never-minted) lot the same way", async function () {
    const f = await mintedFixture();
    await f.token.connect(f.recipient).transfer(f.other.address, NETT_KG);

    const INTENT_2 = 1003n;
    const t0 = await now();
    const a2 = {
      warehouseId: WAREHOUSE_ID,
      intentId: INTENT_2,
      lotId: LOT_1 + 2n,
      receiptNumber: RECEIPT_1 + 2n,
      commodity: "lead",
      nettKg6dec: NETT_KG,
      allowanceRecipient: f.recipient.address,
      timestamp: t0,
    };
    await f.adapter.postAttestation(a2, await signLotAttestation(f.adapter, f.diaSigner, a2));
    const r = { intentId: INTENT_2, timestamp: t0 + 1 };
    await f.adapter.revoke(r, await signRevokeTuple(f.adapter, r, [f.revoke1, f.revoke2, null]));

    await expect(
      f.redeemManager.connect(f.other).redeem(INTENT_2, NETT_KG)
    ).to.be.revertedWithCustomError(f.redeemManager, "LotNotMinted");
  });

  it("nextLotFIFO reports no candidate via `found`, not a 0 sentinel", async function () {
    const f = await deployFixture();
    let [id, found] = await f.registry.nextLotFIFO(WAREHOUSE_ID);
    expect(found).to.equal(false);

    // intentId 0 is a legitimate key and must be distinguishable from "not found" —
    // but a lot is only a FIFO candidate once actually minted (allowanceState Consumed)
    const a0 = {
      warehouseId: WAREHOUSE_ID,
      intentId: 0n,
      lotId: LOT_1,
      receiptNumber: RECEIPT_1,
      commodity: "lead",
      nettKg6dec: NETT_KG,
      allowanceRecipient: f.recipient.address,
      timestamp: await now(),
    };
    await f.adapter.postAttestation(a0, await signLotAttestation(f.adapter, f.diaSigner, a0));
    [id, found] = await f.registry.nextLotFIFO(WAREHOUSE_ID);
    expect(found).to.equal(false); // recorded but not yet minted — not redeemable

    await f.token.setAllowlist(f.recipient.address, true);
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await f.mintManager.connect(f.safe).mint(0n, USDC_REQUIRED, quote, sig);

    [id, found] = await f.registry.nextLotFIFO(WAREHOUSE_ID);
    expect(found).to.equal(true);
    expect(id).to.equal(0n);
  });

  it("nextLotFIFO skips a revoked (never-minted) lot forever, instead of blocking the cursor on it", async function () {
    const f = await deployFixture();
    const t0 = await now();

    // lot A: recorded, then revoked (never minted) — must not block the FIFO cursor
    const aA = {
      warehouseId: WAREHOUSE_ID,
      intentId: 2001n,
      lotId: LOT_1,
      receiptNumber: RECEIPT_1,
      commodity: "lead",
      nettKg6dec: NETT_KG,
      allowanceRecipient: f.recipient.address,
      timestamp: t0,
    };
    await f.adapter.postAttestation(aA, await signLotAttestation(f.adapter, f.diaSigner, aA));
    const r = { intentId: 2001n, timestamp: t0 + 1 };
    await f.adapter.revoke(r, await signRevokeTuple(f.adapter, r, [f.revoke1, f.revoke2, null]));

    // lot B: recorded and minted — the real next candidate
    const aB = {
      warehouseId: WAREHOUSE_ID,
      intentId: 2002n,
      lotId: LOT_1 + 1n,
      receiptNumber: RECEIPT_1 + 1n,
      commodity: "lead",
      nettKg6dec: NETT_KG,
      allowanceRecipient: f.recipient.address,
      timestamp: t0 + 2,
    };
    await f.adapter.postAttestation(aB, await signLotAttestation(f.adapter, f.diaSigner, aB));
    await f.token.setAllowlist(f.recipient.address, true);
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await f.mintManager.connect(f.safe).mint(2002n, USDC_REQUIRED, quote, sig);

    const [id, found] = await f.registry.nextLotFIFO(WAREHOUSE_ID);
    expect(found).to.equal(true);
    expect(id).to.equal(2002n); // skipped straight past the revoked 2001
  });

  describe("adapter emergency pause", function () {
    it("blocks postAttestation while paused", async function () {
      const f = await deployFixture();
      await f.adapter.pause();

      const a = {
        warehouseId: WAREHOUSE_ID,
        intentId: INTENT_1,
        lotId: LOT_1,
        receiptNumber: RECEIPT_1,
        commodity: "lead",
        nettKg6dec: NETT_KG,
        allowanceRecipient: f.recipient.address,
        timestamp: await now(),
      };
      await expect(
        f.adapter.postAttestation(a, await signLotAttestation(f.adapter, f.diaSigner, a))
      ).to.be.revertedWithCustomError(f.adapter, "EnforcedPause");
    });

    it("blocks revoke and finalRelease while paused", async function () {
      const f = await deployFixture();
      const t0 = await now();
      await postLot(f, { recipient: f.recipient.address, timestamp: t0 });
      await f.adapter.pause();

      const r = { intentId: INTENT_1, timestamp: t0 + 1 };
      await expect(
        f.adapter.revoke(r, await signRevokeTuple(f.adapter, r, [f.revoke1, f.revoke2, null]))
      ).to.be.revertedWithCustomError(f.adapter, "EnforcedPause");

      const fr = { intentId: INTENT_1, timestamp: t0 + 1 };
      await expect(
        f.adapter.finalRelease(fr, await signFinalReleaseAttestation(f.adapter, f.diaSigner, fr))
      ).to.be.revertedWithCustomError(f.adapter, "EnforcedPause");
    });

    it("resumes normal operation after unpause", async function () {
      const f = await deployFixture();
      await f.adapter.pause();
      await f.adapter.unpause();

      const a = {
        warehouseId: WAREHOUSE_ID,
        intentId: INTENT_1,
        lotId: LOT_1,
        receiptNumber: RECEIPT_1,
        commodity: "lead",
        nettKg6dec: NETT_KG,
        allowanceRecipient: f.recipient.address,
        timestamp: await now(),
      };
      await f.adapter.postAttestation(a, await signLotAttestation(f.adapter, f.diaSigner, a));
      expect(await f.registry.isLot(INTENT_1)).to.equal(true);
    });

    it("blocks consumeAllowance (mint) while paused", async function () {
      const f = await deployFixture();
      await postLot(f, { recipient: f.recipient.address });
      await f.token.setAllowlist(f.recipient.address, true);
      await f.adapter.pause();

      const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
      const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
      await f.usdc.mint(f.safe.address, USDC_REQUIRED);
      await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
      await expect(
        f.mintManager.connect(f.safe).mint(INTENT_1, USDC_REQUIRED, quote, sig)
      ).to.be.revertedWithCustomError(f.adapter, "EnforcedPause");
    });
  });
});
