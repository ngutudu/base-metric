const hre = require("hardhat");

// Phase 0 deployment (§A): metal-neutral contracts, deployed for lead.
// Push + verify-signature model, single EIP-712 signer per deployment, integer ids
// (confirmed with DIA, 30 Sep) — see docs/contracts-and-data-requirements.md.
async function main() {
  const ethers = hre.ethers;
  const [deployer] = await ethers.getSigners();

  const WAREHOUSE_ID = process.env.WAREHOUSE_ID || "1"; // Steinweg = 1, per DIA
  const USDC = process.env.USDC_ADDRESS;
  const NAV_SIGNER = process.env.NAV_SIGNER || deployer.address;
  // DIA's single EIP-712 attestor key — used for issue and final-release only.
  const DIA_SIGNER = process.env.DIA_SIGNER || deployer.address;
  // 2-of-3 revoke signer set (Basemetric holds one seat), independent of DIA_SIGNER.
  const REVOKE_SIGNERS = (process.env.REVOKE_SIGNERS || `${deployer.address},${deployer.address},${deployer.address}`)
    .split(",")
    .map((s) => s.trim());
  const MULTISIG = process.env.MULTISIG || deployer.address;
  const MAX_SETTLEMENT_DRIFT = process.env.MAX_SETTLEMENT_DRIFT || "10000"; // $0.01, §H
  const MAX_ATTESTATION_AGE = process.env.MAX_ATTESTATION_AGE; // seconds; default 24h in-contract

  if (REVOKE_SIGNERS.length !== 3) {
    throw new Error("REVOKE_SIGNERS must list exactly 3 comma-separated addresses");
  }

  let usdcAddr = USDC;
  if (!usdcAddr) {
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    usdcAddr = await usdc.getAddress();
    console.log("MockUSDC:", usdcAddr);
  }

  const Registry = await ethers.getContractFactory("BasemetricRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();

  const Token = await ethers.getContractFactory("BMTokenPOC");
  const token = await Token.deploy("BaseMetric Lead POC", "bmLEAD");
  await token.waitForDeployment();

  const Treasury = await ethers.getContractFactory("Treasury");
  // Deploy owned by deployer for setup wiring, then hand ownership to the multisig.
  const treasury = await Treasury.deploy(usdcAddr, deployer.address);
  await treasury.waitForDeployment();

  const Adapter = await ethers.getContractFactory("WarrantPoRAdapter");
  const adapter = await Adapter.deploy(WAREHOUSE_ID, DIA_SIGNER, await registry.getAddress());
  await adapter.waitForDeployment();

  const MintManager = await ethers.getContractFactory("MintManager");
  const mintManager = await MintManager.deploy(
    await token.getAddress(),
    await treasury.getAddress(),
    await registry.getAddress(),
    usdcAddr,
    NAV_SIGNER,
    MAX_SETTLEMENT_DRIFT
  );
  await mintManager.waitForDeployment();

  const RedeemManager = await ethers.getContractFactory("RedeemManager");
  const redeemManager = await RedeemManager.deploy(
    await token.getAddress(),
    await treasury.getAddress(),
    await registry.getAddress(),
    NAV_SIGNER
  );
  await redeemManager.waitForDeployment();

  // wiring
  await (await token.setMintManager(await mintManager.getAddress())).wait();
  await (await token.setRedeemManager(await redeemManager.getAddress())).wait();
  await (await treasury.setMintManager(await mintManager.getAddress())).wait();
  await (await treasury.setRedeemManager(await redeemManager.getAddress())).wait();
  await (await registry.setRedeemManager(await redeemManager.getAddress())).wait();
  await (await adapter.setMintManager(await mintManager.getAddress())).wait();
  await (await adapter.setRevokeSigners(REVOKE_SIGNERS)).wait();
  if (MAX_ATTESTATION_AGE) {
    await (await adapter.setMaxAttestationAge(MAX_ATTESTATION_AGE)).wait();
  }
  await (await registry.registerWarehouse(WAREHOUSE_ID, await adapter.getAddress())).wait();

  // Hand Treasury custody to the multisig now that wiring is done.
  if (MULTISIG.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await treasury.transferOwnership(MULTISIG)).wait();
  }

  console.log({
    registry: await registry.getAddress(),
    token: await token.getAddress(),
    treasury: await treasury.getAddress(),
    adapter: await adapter.getAddress(),
    mintManager: await mintManager.getAddress(),
    redeemManager: await redeemManager.getAddress(),
    diaSigner: DIA_SIGNER,
    revokeSigners: REVOKE_SIGNERS,
    warehouseId: WAREHOUSE_ID,
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
