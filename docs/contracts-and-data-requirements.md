# BaseMetric Phase 0 — Smart Contracts & Data Requirements

**Spec version:** 26 Aug r4 + Flow Brief v7 · **Model:** metal-neutral naming + DIA allowance model + **push + verify-signature, integer ids** (confirmed with imaohw1 / DIA, 30 Sep 2026)
**Date:** 2026-10-01 — supersedes the 2026-09-30 cut, which used a single EIP-712 signer for all three attestation types including revoke.

This document lists: (1) the 6 contracts built and what each contains, (2) the data / actions required from **DIA**, (3) the data / actions required from **BaseMetric**.

---

## 1. Architecture overview

```
DIA (off-chain) ──signs LotAttestation / FinalReleaseAttestation, 1 key──▶ payload + signature
DIA 2-of-3 ──────signs RevokeAttestation, Basemetric holds 1 seat────────▶ payload + 2 of 3 sigs
                                                                             │
                                          ANYONE can relay this on-chain —
                                          authenticity comes from the signature(s)
                                                                             ▼
                              WarrantPoRAdapter.postAttestation / .revoke / .finalRelease
                                verifies signer(s) + timestamp ordering + freshness
                                                                             ▼
                                          BasemetricRegistry (reserve auto-derived)
                                                                             ▲
   NAV bot (BaseMetric) ──sign EIP-712──▶ MintManager ───────────────────────┤
                          │  ├─ consumeAllowance                             │
                          │  └─ USDC ──▶ Treasury                            │
                          ▼                                                 │
                     BMTokenPOC (mint)                                       │
                                                                             │
   Holder ──redeem()──▶ RedeemManager ─ burn BMTokenPOC ─ markLotRedeemed ───┘
                          └─ (ceremony) Treasury ──USDC──▶ Holder

   ... later: DIA signs FinalReleaseAttestation({intentId, timestamp}) → reserve deducts
```

**"Source of truth" boundary:**

| Data | Source of truth |
|---|---|
| Lot data, allowance issuance, reserve release | **DIA**, via a **signed attestation** (1 key) the adapter verifies |
| Allowance revocation ("removing" an intentId) | **DIA 2-of-3 multisig, Basemetric holds one seat** — independent of DIA's own routine attestation key |
| Reserve total | **Derived on-chain**: +weight on issue, −weight on release/revoke. DIA pushes the net-weight delta per lot; "it will be aggregated in the smart contract" (imaohw1, 30 Sep) — confirmed this means our contract |
| Allowance **Consumed**, lot **Redeemed**, FIFO ordering | **BaseMetric** (`BasemetricRegistry`) |
| NAV price (USDC/kg) | **BaseMetric** (EIP-712 signing bot) |
| Wallet allowlist, warehouse registration, pause, fees, ceremony | **BaseMetric** (owner / multisig) |

**IDs are integers, not hashes.** Confirmed with DIA (30 Sep): "*we're thinking about integer ids due to names being more complex and error prone*." `warehouseId`, `intentId`, `lotId`, `receiptNumber` are all `uint256`.

**`intentId` is the on-chain key** — DIA's internal, per-lot-**unique** handle, used for minting, revoking, and burning alike. It is **not** the same as "Lot ID" (which DIA confirmed **can repeat** when a lot changes hands) nor "Receipt number" (always unique, but informational only on our side — not the mint/burn reference).

**Two different signer sets, two different purposes:**

| Action | Signer(s) | Why |
|---|---|---|
| Issue (`postAttestation`), Final Release (`finalRelease`) | DIA's single attestor key (`feedAddress`) | DIA's own routine attestation of what they verified |
| Revoke (`revoke`) | **2-of-3** (`revokeSigners[3]`, Basemetric holds 1 seat) | Flow Brief v7 §1.2 term 4 — explicitly so revocation **does not depend on DIA acting alone** |

**Numeric convention:** all weights are **kilograms, 6 decimal places** (`Kg6dec`). 1 token = 1 kg. USDC is assumed to have 6 decimals. No metal name appears in any contract or identifier.

---

## 2. The six contracts

### 2.1 `BMTokenPOC.sol` — Token

Unchanged. ERC-20, 6 decimals, 1 token = 1 kg, mint/burn gated to MintManager/RedeemManager, Phase 0 transfer lock + allowlist.

### 2.2 `MintManager.sol` — Minting

`mint(uint256 intentId, uint256 usdcAmount, NavQuote navQuote, bytes signature)`: checks the registry's allowance is `Issued`, recipient allowlisted, reserve not stale, NAV signature valid, drift within tolerance; sizes the mint as `mintAmountKg6dec = lot.nettKg6dec`; calls `adapter.consumeAllowance()`; moves USDC to Treasury; mints; asserts `totalSupply() ≤ registry.getReserve()`.

A concurrent revoke is resolved by plain transaction ordering (§B) — revoke is itself a verified on-chain write against the registry now, not a live external read.

### 2.3 `RedeemManager.sol` — Burning

`redeem(uint256 intentId, uint256 burnAmountKg6dec)` = commercial (burn only). `redeemCeremony(uint256 intentId, ...)` = Phase 0 atomic burn + payout derived from a signed NAV quote. Neither touches the reserve — that only moves via `WarrantPoRAdapter.finalRelease()`.

**A lot must actually have been minted (`allowanceState == Consumed`) before it can be redeemed.** Without this check, a holder could burn unrelated (fungible) tokens against a never-minted or revoked lot's bookkeeping slot — marking it `Redeemed` while its allowance was still `Issued` and separately mintable, corrupting the lot's state permanently. `redeem`/`redeemCeremony` revert `LotNotMinted` otherwise.

### 2.4 `WarrantPoRAdapter.sol` — DIA bridge (push + verify)

One instance per warehouse. Two independent verification paths:

| Function | Caller | Verifies | Effect |
|---|---|---|---|
| `postAttestation(LotAttestation, signature)` | **anyone** (auth is the signature) | `feedAddress` (1 key) + timestamp ordering + freshness | `registry.recordLot(...)` — issues the allowance, raises the reserve by the attested weight |
| `revoke(RevokeAttestation, bytes[3] signatures)` | **anyone** | **2-of-3** raw ECDSA against `revokeSigners`, positionally matched (`signatures[i]` must be `revokeSigners[i]` or empty `"0x"`) + ordering | `registry.markAllowanceRevoked(...)` — **also reverses the reserve added at issuance** (see below) |
| `finalRelease(FinalReleaseAttestation, signature)` | **anyone** | `feedAddress` + ordering | `registry.markReserveReleased(...)` — reserve deducts here, **not** at the burn |
| `consumeAllowance(intentId)` | **MintManager only** | — (blocked if paused) | `registry.markAllowanceConsumed(...)` |
| `setFeedAddress` / `setRevokeSigners` / `setMaxAttestationAge` / `setMintManager` | owner | — | Wiring |
| `pause` / `unpause` | owner | — | Emergency stop — blocks all 4 mutating functions above, e.g. on suspected `feedAddress` compromise |

**Ordering + freshness (confirmed with DIA, 30 Sep):** there is no separate sequence number. `timestamp` (scoped per warehouse — i.e. per adapter instance, shared across all 3 message types) must be strictly increasing, **and** is bounded by a freshness window (`maxAttestationAge`, default 24h, owner-adjustable — DIA's real push latency will tell us the right value).

**`LotAttestation` fields:** `warehouseId, intentId, lotId, receiptNumber, commodity, nettKg6dec, allowanceRecipient, timestamp`. `RevokeAttestation` / `FinalReleaseAttestation`: `{ intentId, timestamp }` only — quantity is looked up via `intentId`, never resent (confirmed).

**EIP-712 domain:** `name: "BaseMetricPoR", version: "1"` — our proposal; DIA has not yet confirmed they'll sign against this exact domain (see §5).

**Revoke reverses the reserve it added at issuance.** A revoked lot can never reach `Redeemed` (RedeemManager requires `Consumed`), so without this it would inflate `reserve` forever with no way to unwind it. If DIA later re-attests the same physical lot under a new `intentId`, that re-issuance then adds the weight back exactly once instead of double-counting it.

### 2.5 `BasemetricRegistry.sol` — Source of truth (local)

Keyed by `intentId` (`uint256`), not `lotId`/`receiptNumber` (confirmed non-unique / not the mint-burn reference respectively). Reserve is derived, not transmitted:
- `recordLot(...)` — `reserve += nettKg6dec`.
- `markAllowanceRevoked(...)` — `reserve -= nettKg6dec` (new — see §2.4).
- `markReserveReleased(...)` — `reserve -= nettKg6dec`, guarded by: the lot must already be `Redeemed` and not already released.

`Lot` struct: `warehouseId, intentId, lotId, receiptNumber, nettKg6dec, commodity, allowanceRecipient, allowanceState, lotState, reserveReleased, insertionIndex`. `lotId`/`receiptNumber` are stored for audit only — no on-chain logic keys off them.

`nextLotFIFO(warehouseId)` returns `(intentId, found)` — a lot only counts as a FIFO candidate once it's actually `Consumed` (minted) and not yet `Redeemed`. A revoked (never-minted) lot keeps `lotState == Active` forever (it can never be redeemed), so it must be — and is — skipped the same way a redeemed lot is, or it would permanently block the cursor.

Other functions (`isStale`, `isReserveDeficit`, `markAllowanceConsumed`, `markLotRedeemed`) unchanged in shape, `uint256`-keyed throughout.

### 2.6 `Treasury.sol` — USDC custody

Unchanged.

### Supporting files

| File | Role |
|---|---|
| `interfaces/IOracleAdapter.sol` | Abstract boundary the registry holds (§A.4). Revocation is not in this interface — its signing scheme is vendor-specific |
| `lib/BaseMetricTypes.sol` | `AllowanceState`, `LotState`, `NavQuote`, `LotAttestation`, `RevokeAttestation`, `FinalReleaseAttestation` |
| `mocks/MockUSDC.sol` | Test only |

---

## 3. Data required from DIA

### 3.1 `LotAttestation` — DIA verifies a warehouse receipt

| Field | Type | Meaning | Status |
|---|---|---|---|
| `warehouseId` | `uint256` | Which warehouse (Steinweg = 1) | ✅ confirmed integer |
| `intentId` | `uint256` | **The on-chain key** — unique per lot, used for mint, revoke, and burn | ✅ confirmed |
| `lotId` | `uint256` | Physical lot reference — **can repeat** if the lot changes hands | ✅ confirmed non-unique; stored for audit only |
| `receiptNumber` | `uint256` | **Always unique**, but not the mint/burn key | ✅ confirmed; stored for audit only |
| `commodity` | `string` | e.g. `"lead"` | ✅ |
| `nettKg6dec` | `uint256` | Attested net weight — also the allowance amount, 1:1 | ✅ confirmed |
| `allowanceRecipient` | `address` | The wallet permitted to mint | ✅ confirmed — "that's the address which can mint" |
| `timestamp` | `uint256` | Orders the message (strictly increasing per warehouse) **and** is checked for freshness | ✅ confirmed — no separate sequence number |
| *(signature)* | `bytes` | Over the struct above, EIP-712, DIA's single attestor key | ✅ confirmed |

### 3.2 `RevokeAttestation` — "removing" an intentId

`{ intentId, timestamp }`, **2-of-3 signatures** (Flow Brief v7 §1.2 term 4, Basemetric holds one seat) — ⚠️ **not yet explicitly confirmed by DIA**. imaohw1's 30 Sep answer ("EIP-712... single key per deployment") most likely describes the routine attestation key (issue/final-release), but was never asked specifically about revoke's signer composition. See §5 item 1 — this is the single most important open question left.

### 3.3 `FinalReleaseAttestation` — reserve deduction after redemption

`{ intentId, timestamp }`, confirmed directly: *"it would be intent_id + timestamp + signature. Quantity is automatically picked up by intent_id."* Single key, same as issue.

### 3.4 What DIA does **not** need to send

- **A running reserve total** — derived on our side from the net-weight deltas DIA pushes per lot.
- **A separate allowance amount** — always equal to the attested net weight.
- **An allowance-state field** — implied by which of the three functions is called.

---

## 4. Data / actions required from BaseMetric

### 4.1 On-chain — state BaseMetric owns

| Data | Contract | Written by |
|---|---|---|
| Allowance `Consumed` | `BasemetricRegistry` | `MintManager` (via the adapter), atomic with the mint |
| Lot `Redeemed` | `BasemetricRegistry` | `RedeemManager`, after the burn (only once the lot is `Consumed`) |
| Reserve (derived) | `BasemetricRegistry` | Automatically, on `recordLot` / `markAllowanceRevoked` / `markReserveReleased` |
| Lot FIFO ordering | `BasemetricRegistry` | automatic on `recordLot` / `markLotRedeemed` |

### 4.2 Off-chain — BaseMetric must provide / operate

| Component | Description | Held by |
|---|---|---|
| **NAV signer bot** | Signs `NavQuote` (EIP-712) | Issuer-controlled key (Anthony) |
| **Nominate the lot to redeem** | Off-chain agreement on which `intentId`, then call `redeem(...)` | BaseMetric Ops |
| **Trigger the mint** | 3/3 Safe calls `MintManager.mint(...)` manually (Phase 0) — no `msg.sender` check in the contract, purely an operational convention | 3/3 Safe |
| **Relay DIA's signed attestations on-chain** | Someone must submit `postAttestation`/`revoke`/`finalRelease` — permissionless, but needs an operator | BaseMetric (or DIA itself) |
| **One seat on the revoke signer set** | Hold 1 of the 3 `revokeSigners` keys, co-sign `RevokeAttestation` with DIA | BaseMetric (per Flow Brief §1.2 term 4) |
| **USDC for the ceremony** | Fund the Treasury to the top of the plausible price × weight band + gas | BaseMetric |

### 4.3 Parameters & admin actions (owner / multisig)

Unchanged from the previous cut, plus: `setFeedAddress(diaSignerKey)`, `setRevokeSigners([k1,k2,k3])`, `setMaxAttestationAge(seconds)`, `pause()`/`unpause()` on `WarrantPoRAdapter`.

---

## 5. Still open

1. **Confirm revoke's signer composition with DIA.** Flow Brief v7 says 2-of-3 with Basemetric holding one seat; imaohw1's "single key per deployment" answer may only have been describing the routine attestation key. The code currently implements 2-of-3 for `revoke()` specifically (our best-effort reconciliation of both sources) — needs an explicit confirmation either way before production.
2. **EIP-712 domain/struct format** — we've proposed `"BaseMetricPoR"` / `"1"` with the field lists in §3; DIA has not yet confirmed they'll sign exactly this shape.
3. **Attestation freshness window value** — currently defaulted to 24h; needs tuning once DIA's actual push latency/SLA is known.
4. **Multi-lot subscription arity (§K.2 from the earlier spec)** — one `intentId` per lot is what's implemented; whether DIA ever batches multiple lots under one intent is unaddressed.
5. **Third seat composition on the revoke signer set** — Flow Brief watch item #3: "DIA + Basemetric + a neutral is balanced; two DIA seats puts us back to depending on them." Who holds the third key is not yet decided.

---

## 6. Build status

- 6 contracts + interfaces: **compiles clean** (Solidity 0.8.24, evmVersion cancun, OZ v5).
- Tests: **28/28 pass** (`npm test`) — covers signature verification (valid/invalid signer, replay, freshness window), 2-of-3 revoke (valid/insufficient/unknown-signer), mint, both redeem branches (including the `LotNotMinted` guard), the revoke↔mint race, the full reserve lifecycle (issue → burn → finalRelease decrement, plus revoke reversing the reserve and a re-issue not double-counting it), FIFO correctly skipping revoked lots, and the adapter's emergency pause blocking all four mutating entry points.
- Deploy script: `npx hardhat run scripts/deploy.js` (env `DIA_SIGNER`, `REVOKE_SIGNERS` — 3 comma-separated addresses, `WAREHOUSE_ID`, `MAX_ATTESTATION_AGE`).
- **Not audited.**
