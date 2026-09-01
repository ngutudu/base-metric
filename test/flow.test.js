const { expect } = require("chai");
const { ethers } = require("hardhat");

const WAREHOUSE_ID = ethers.keccak256(ethers.toUtf8Bytes("STEINWEG-SG"));
const MAX_DRIFT = 10_000n; // $0.01 in 6dp base units (§H)
const ZERO = ethers.ZeroHash;

async function deployFixture() {
  const [deployer, navSigner, multisig, safe, recipient, other] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const dia = await (await ethers.getContractFactory("MockDIAWarrantOracle")).deploy();
  const registry = await (await ethers.getContractFactory("BasemetricRegistry")).deploy();
  const token = await (await ethers.getContractFactory("BMTokenPOC")).deploy("BaseMetric Lead POC", "bmLEAD");
  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(
    await usdc.getAddress(),
    deployer.address
  );
  const adapter = await (await ethers.getContractFactory("WarrantPoRAdapter")).deploy(
    WAREHOUSE_ID,
    await dia.getAddress(),
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
  await registry.registerWarehouse(WAREHOUSE_ID, await adapter.getAddress());

  return {
    deployer, navSigner, multisig, safe, recipient, other,
    usdc, dia, registry, token, treasury, adapter, mintManager, redeemManager,
  };
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

describe("BaseMetric Phase 0 flow (DIA pull model)", function () {
  const RECEIPT_1 = ethers.keccak256(ethers.toUtf8Bytes("RECEIPT-1"));
  const NETT_KG = 25_100_437_000n; // 25,100.437 kg, 6dp (§H worked example)
  const NAV_PRICE = 2_483_700n; // $2.4837 /kg
  const USDC_REQUIRED = (NETT_KG * NAV_PRICE) / 1_000_000n; // 62,341,955,376

  // DIA pushes a reserve + lot into its oracle, then anyone syncs it into the registry.
  async function diaPublishAndSync(f, { receiptId = RECEIPT_1, recipient, seq = 1n } = {}) {
    await f.dia.pushReserve(WAREHOUSE_ID, NETT_KG, seq);
    await f.dia.pushLot(receiptId, WAREHOUSE_ID, NETT_KG, "lead", NETT_KG, recipient);
    await f.adapter.sync(receiptId);
  }

  async function mintedFixture() {
    const f = await deployFixture();
    await diaPublishAndSync(f, { recipient: f.recipient.address });
    await f.token.setAllowlist(f.recipient.address, true);

    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await f.mintManager.connect(f.safe).mint(RECEIPT_1, USDC_REQUIRED, quote, sig);
    return f;
  }

  it("syncs a DIA lot into the registry and records the allowance", async function () {
    const f = await deployFixture();
    await diaPublishAndSync(f, { recipient: f.recipient.address });
    const lot = await f.registry.getLot(RECEIPT_1);
    expect(lot.nettKg6dec).to.equal(NETT_KG);
    expect(lot.allowanceRecipient).to.equal(f.recipient.address);
    expect(lot.allowanceState).to.equal(1); // Issued
    expect(await f.registry.getReserve()).to.equal(NETT_KG);
  });

  it("mints the attested weight and routes USDC to Treasury", async function () {
    const f = await mintedFixture();
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(NETT_KG);
    expect(await f.token.totalSupply()).to.equal(NETT_KG);
    expect(await f.treasury.balance()).to.equal(USDC_REQUIRED);
    const [, , state] = await f.registry.allowanceOf(RECEIPT_1);
    expect(state).to.equal(2); // Consumed
  });

  it("blocks a second mint against a consumed allowance", async function () {
    const f = await mintedFixture();
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 2 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await expect(
      f.mintManager.connect(f.safe).mint(RECEIPT_1, USDC_REQUIRED, quote, sig)
    ).to.be.revertedWithCustomError(f.mintManager, "NoIssuedAllowance");
  });

  it("reverts a mint whose USDC drifts beyond MAX_SETTLEMENT_DRIFT", async function () {
    const f = await deployFixture();
    await diaPublishAndSync(f, { recipient: f.recipient.address });
    await f.token.setAllowlist(f.recipient.address, true);
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    const bad = USDC_REQUIRED + 1_000_000n; // $1 off
    await f.usdc.mint(f.safe.address, bad);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), bad);
    await expect(
      f.mintManager.connect(f.safe).mint(RECEIPT_1, bad, quote, sig)
    ).to.be.revertedWithCustomError(f.mintManager, "SettlementDriftTooLarge");
  });

  it("reverts a mint to a de-whitelisted recipient", async function () {
    const f = await deployFixture();
    await diaPublishAndSync(f, { recipient: f.recipient.address }); // not allowlisted
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 1 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await expect(
      f.mintManager.connect(f.safe).mint(RECEIPT_1, USDC_REQUIRED, quote, sig)
    ).to.be.revertedWithCustomError(f.mintManager, "RecipientNotAllowlisted");
  });

  it("propagates a DIA-side revocation into the registry (permissionless)", async function () {
    const f = await deployFixture();
    await diaPublishAndSync(f, { recipient: f.recipient.address });
    await f.dia.revoke(RECEIPT_1);
    await f.adapter.connect(f.other).revokeAllowance(RECEIPT_1);
    const [, , state] = await f.registry.allowanceOf(RECEIPT_1);
    expect(state).to.equal(3); // Revoked
  });

  it("blocks a mint when DIA revoked after the last sync (race resolved on-chain)", async function () {
    const f = await deployFixture();
    await diaPublishAndSync(f, { recipient: f.recipient.address });
    await f.token.setAllowlist(f.recipient.address, true);
    // registry cache still says Issued; DIA revokes; no re-sync happens
    await f.dia.revoke(RECEIPT_1);
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 7 };
    const sig = await signNavQuote(f.mintManager, f.navSigner, quote);
    await f.usdc.mint(f.safe.address, USDC_REQUIRED);
    await f.usdc.connect(f.safe).approve(await f.mintManager.getAddress(), USDC_REQUIRED);
    await expect(
      f.mintManager.connect(f.safe).mint(RECEIPT_1, USDC_REQUIRED, quote, sig)
    ).to.be.revertedWithCustomError(f.adapter, "AllowanceNotIssuedOnDIA");
  });

  it("sync ignores a stale DIA reserve sequence", async function () {
    const f = await deployFixture();
    await f.dia.pushReserve(WAREHOUSE_ID, NETT_KG, 5n);
    await f.adapter.sync(ZERO);
    await f.dia.pushReserve(WAREHOUSE_ID, 999n, 3n); // lower seq
    await f.adapter.sync(ZERO);
    expect(await f.registry.getReserve()).to.equal(NETT_KG);
  });

  it("ceremony redemption burns the lot and pays USDC (payout derived from NAV)", async function () {
    const f = await mintedFixture();
    await f.redeemManager.setCeremonyEnabled(true);
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 99 };
    const sig = await signNavQuote(f.redeemManager, f.navSigner, quote, "BaseMetricRedeemManager");
    await expect(
      f.redeemManager.connect(f.recipient).redeemCeremony(RECEIPT_1, NETT_KG, quote, sig)
    ).to.emit(f.redeemManager, "CeremonySettled");
    expect(await f.token.totalSupply()).to.equal(0);
    expect(await f.treasury.balance()).to.equal(0); // round trip at same NAV → zero delta (§H)
  });

  it("ceremony redemption rejects a bad NAV quote", async function () {
    const f = await mintedFixture();
    await f.redeemManager.setCeremonyEnabled(true);
    const quote = { navPriceUsdc6PerKg: NAV_PRICE, validUntil: (await now()) + 3600, nonce: 42 };
    const badSig = await signNavQuote(f.redeemManager, f.deployer, quote, "BaseMetricRedeemManager");
    await expect(
      f.redeemManager.connect(f.recipient).redeemCeremony(RECEIPT_1, NETT_KG, quote, badSig)
    ).to.be.revertedWithCustomError(f.redeemManager, "BadNavSignature");
  });

  it("commercial redemption burns the lot with no Treasury withdrawal", async function () {
    const f = await mintedFixture();
    await f.redeemManager.connect(f.recipient).redeem(RECEIPT_1, NETT_KG);
    expect(await f.token.totalSupply()).to.equal(0);
    expect(await f.treasury.balance()).to.equal(USDC_REQUIRED); // untouched
    expect((await f.registry.getLot(RECEIPT_1)).lotState).to.equal(2); // Redeemed
  });

  it("rejects a partial-lot redemption", async function () {
    const f = await mintedFixture();
    await expect(
      f.redeemManager.connect(f.recipient).redeem(RECEIPT_1, NETT_KG - 1n)
    ).to.be.revertedWithCustomError(f.redeemManager, "NotWholeLot");
  });

  it("burn does not deduct the reserve (reserve reads above supply)", async function () {
    const f = await mintedFixture();
    await f.redeemManager.connect(f.recipient).redeem(RECEIPT_1, NETT_KG);
    expect(await f.registry.getReserve()).to.equal(NETT_KG);
    expect(await f.token.totalSupply()).to.equal(0);
  });
});
