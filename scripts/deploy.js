const hre = require("hardhat");

// Phase 0 deployment (§A): metal-neutral contracts, deployed for lead.
async function main() {
  const ethers = hre.ethers;
  const [deployer] = await ethers.getSigners();

  const WAREHOUSE_ID = ethers.keccak256(ethers.toUtf8Bytes("STEINWEG-SG"));
  const USDC = process.env.USDC_ADDRESS;
  const NAV_SIGNER = process.env.NAV_SIGNER || deployer.address;
  // DIA's deployed oracle contract (§K.1 pull model). If unset, a mock is deployed.
  let DIA_ORACLE = process.env.DIA_ORACLE_ADDRESS;
  const MULTISIG = process.env.MULTISIG || deployer.address;
  const MAX_SETTLEMENT_DRIFT = process.env.MAX_SETTLEMENT_DRIFT || "10000"; // $0.01, §H

  let usdcAddr = USDC;
  if (!usdcAddr) {
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    usdcAddr = await usdc.getAddress();
    console.log("MockUSDC:", usdcAddr);
  }

  if (!DIA_ORACLE) {
    const MockDIA = await ethers.getContractFactory("MockDIAWarrantOracle");
    const dia = await MockDIA.deploy();
    await dia.waitForDeployment();
    DIA_ORACLE = await dia.getAddress();
    console.log("MockDIAWarrantOracle:", DIA_ORACLE);
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
  const adapter = await Adapter.deploy(WAREHOUSE_ID, DIA_ORACLE, await registry.getAddress());
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
    diaOracle: DIA_ORACLE,
    warehouseId: WAREHOUSE_ID,
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
