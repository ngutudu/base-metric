# BaseMetric Phase 0 Contracts

Hardhat implementation of the **26 Aug r4** spec — metal-neutral naming, DIA allowance
model shipping in Phase 0.

```bash
npm install
npm run build      # hardhat compile
npm test           # hardhat test
npx hardhat run scripts/deploy.js
```

## Contracts (`contracts/`)

| File | Role | Spec |
|---|---|---|
| `BMTokenPOC.sol` | ERC-20, 6dp, 1 token = 1 kg. name/symbol are ctor params (Phase 0: `bmLEAD`). Only MintManager mints, only RedeemManager burns (real OZ `_burn`). Phase 0 transfer lock + allowlist; de-whitelisted mint **reverts**. | §A.1, §F |
| `MintManager.sol` | Consumes a DIA allowance, mints the **attested weight** (`mintAmountKg6dec = allowance.amountKg6dec`), takes matching USDC into Treasury. EIP-712 NAV quote (single-use nonce). `MAX_SETTLEMENT_DRIFT` in base units, not %. Stale-reserve backstop + `totalSupply() <= getReserve()` post-mint. | §A.2, §H |
| `RedeemManager.sol` | Burns against a **named lot** (whole-lot). `redeem()` = commercial (burn only, settlement off-chain). `redeemCeremony()` = Phase 0 atomic burn + Treasury payout (behind `ceremonyEnabled`, payout **derived from a signed NAV quote** so it can't be over-withdrawn). Burn never deducts the reserve. | §A.3, §E, §I.8 |
| `WarrantPoRAdapter.sol` | **Pull model (§K.1):** a thin reader over DIA's own deployed oracle contract (`IDIAWarrantOracle`). `sync(receiptId)` copies reserve + lot + allowance into the registry — permissionless, idempotent, **no keeper role**. `consumeAllowance` (MintManager only) re-reads DIA **live** so a revoke landing after the last sync still blocks the mint. `revokeAllowance` relays a DIA-side revocation (anyone may call). One instance per warehouse; constructor shape unchanged. | §A.4, §K.1 |
| `BasemetricRegistry.sol` | Source of truth for BaseMetric-local state. Per-warehouse reserve cache + per-lot records with FIFO ordering (`nextLotFIFO`), allowance state machine, staleness/deficit views. `getReserve()` returns the aggregate. | §A.5 |
| `Treasury.sol` | USDC custody. deposit ← MintManager, withdraw ← RedeemManager, adminWithdraw ← multisig. Unchanged. | §A.6 |

`contracts/lib/BaseMetricTypes.sol` holds the `NavQuote` struct + allowance/lot enums.
`contracts/interfaces/IDIAWarrantOracle.sol` is the contract DIA deploys and pushes to.
`contracts/mocks/` (MockUSDC, MockDIAWarrantOracle) are test-only.

## DIA integration — pull model (§K.1)

```
DIA off-chain ──push──▶ IDIAWarrantOracle (DIA's contract) ◀──pull── WarrantPoRAdapter ──▶ BasemetricRegistry
```

DIA is the source of truth for **reserve figures** and **allowance issuance / revocation**.
BaseMetric owns **consumed** and **redeemed** state locally. The adapter carries no
signature or sequence verification — trust rests on the configured DIA oracle address —
and `sync()` is permissionless, which is the answer to the open `KEEPER_ROLE` question.
`DIA_ORACLE_ADDRESS` env var points the adapter at the real contract; unset → a mock is
deployed. DIA's contract must expose per-receipt allowance data + a per-warehouse
sequence/timestamp; the `IDIAWarrantOracle` ABI in this repo is our proposed shape.

## Allowance lifecycle (§B)

`None → Issued` (DIA's oracle) → `Consumed` (MintManager, atomic with mint) — terminal.
`Issued → Revoked` (DIA 2-of-3, on DIA's oracle; relayed here). No expiry. Burning creates
no allowance.

## Open items that block real deployment

Allowance function names are LOC's to finalise. §K still open: multi-lot subscription
arity, `MAX_SETTLEMENT_DRIFT` value, lead procurement basis (§K.9), title-branch deduction
trigger (§K.8). §K.1 resolved here as **pull**, pending DIA confirming the `IDIAWarrantOracle`
ABI.
