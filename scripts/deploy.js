const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Phase 0 deployment (§A): metal-neutral contracts, deployed for lead.
// Push + verify-signature model, single EIP-712 signer per deployment, integer ids
// (confirmed with DIA, 30 Sep) — see docs/contracts-and-data-requirements.md.
async function main() {
  const ethers = hre.ethers;
  // Distinct default signers (same ordering as test/flow.test.js) so a plain
  // `npx hardhat run scripts/deploy.js --network localhost` gives the UI genuinely
  // different accounts per role, not everything defaulting to the deployer.
  const [deployer, navSigner, diaSigner, multisigSigner, safe, recipient, other, revoke1, revoke2, revoke3] =
    await ethers.getSigners();

  const WAREHOUSE_ID = process.env.WAREHOUSE_ID || "1"; // Steinweg = 1, per DIA
  const USDC = process.env.USDC_ADDRESS;
  const NAV_SIGNER = process.env.NAV_SIGNER || navSigner.address;
  // DIA's single EIP-712 attestor key — used for issue and final-release only.
  const DIA_SIGNER = process.env.DIA_SIGNER || diaSigner.address;
  // 2-of-3 revoke signer set (Basemetric holds one seat), independent of DIA_SIGNER.
  const REVOKE_SIGNERS = (
    process.env.REVOKE_SIGNERS || `${revoke1.address},${revoke2.address},${revoke3.address}`
  )
    .split(",")
    .map((s) => s.trim());
  const MULTISIG = process.env.MULTISIG || multisigSigner.address;
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

  const network = await ethers.provider.getNetwork();

  const deployment = {
    chainId: Number(network.chainId),
    rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8545",
    warehouseId: WAREHOUSE_ID,
    contracts: {
      usdc: usdcAddr,
      registry: await registry.getAddress(),
      token: await token.getAddress(),
      treasury: await treasury.getAddress(),
      adapter: await adapter.getAddress(),
      mintManager: await mintManager.getAddress(),
      redeemManager: await redeemManager.getAddress(),
    },
    roles: {
      deployer: deployer.address,
      navSigner: NAV_SIGNER,
      diaSigner: DIA_SIGNER,
      multisig: MULTISIG,
      safe: safe.address,
      recipient: recipient.address,
      other: other.address,
      revoke1: revoke1.address,
      revoke2: revoke2.address,
      revoke3: revoke3.address,
    },
  };

  console.log(deployment);

  // Write out for the test UI (ui/) — see ui/README.md.
  const uiConfigPath = path.join(__dirname, "..", "ui", "src", "deployment.json");
  fs.mkdirSync(path.dirname(uiConfigPath), { recursive: true });
  fs.writeFileSync(uiConfigPath, JSON.stringify(deployment, null, 2));
  console.log("Wrote UI config:", uiConfigPath);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
