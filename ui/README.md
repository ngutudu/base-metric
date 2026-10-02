# BaseMetric test console

UI React đơn giản để bấm thử **mọi hàm** của 6 contract, chạy trên **Hardhat node local**. Tự ký giao dịch bằng các private key test mặc định của Hardhat — **không cần MetaMask, không dùng được với mạng thật** (các key này công khai, ai cũng derive được).

## Chạy

**Cách nhanh nhất** — 1 lệnh duy nhất từ gốc repo, tự khởi động node, deploy, và chạy UI:

```bash
./scripts/dev.sh
```

Ctrl+C để dừng hết (cả node lẫn UI). Script tự dừng node cũ (nếu có) trước khi khởi động node mới — chạy lại script này bất cứ lúc nào để có state sạch từ đầu.

**Cách thủ công** (tương đương), từ thư mục gốc repo (`base-metric/`), 2 cửa sổ terminal:

```bash
# 1) node local
npx hardhat node

# 2) deploy — tự ghi địa chỉ contract vào ui/src/deployment.json
npx hardhat run scripts/deploy.js --network localhost
```

Rồi trong `ui/`:

```bash
npm install
npm run dev    # http://localhost:5173
```

Mỗi lần restart node local, phải chạy lại bước deploy (địa chỉ contract đổi) rồi **reload lại trang trình duyệt** (để xoá state `NonceManager` cũ trong bộ nhớ UI, tránh lệch nonce với node mới).

## Các tài khoản có sẵn

10 tài khoản test mặc định của Hardhat, gán sẵn vai trò (khớp với `test/flow.test.js` và `scripts/deploy.js`):

| Vai trò | Dùng để |
|---|---|
| `deployer` | owner của mọi contract |
| `diaSigner` | ký `LotAttestation` / `FinalReleaseAttestation` |
| `revoke1/2/3` | 2-of-3 ký `RevokeAttestation` |
| `navSigner` | ký `NavQuote` cho mint/redeem ceremony |
| `safe` | gọi `mint()` (quy ước "3/3 Safe") |
| `recipient` | ví nhận allowance mặc định khi test |
| `other` | dùng để minh hoạ "ai cũng relay được" attestation |
| `multisig` | owner của `Treasury` |

Xem địa chỉ đầy đủ trong sidebar UI ("Role addresses") hoặc `ui/src/deployment.json`.

## Các tab

1. **DIA Attestation** — ký & gửi `postAttestation` / `revoke` (2-of-3) / `finalRelease`; pause/unpause adapter
2. **Mint** — faucet USDC cho `safe`, ký `NavQuote`, gọi `mint()`
3. **Redeem** — `redeem()` (chỉ đốt) hoặc `redeemCeremony()` (đốt + trả USDC atomic)
4. **Registry (read)** — xem reserve, lô, FIFO — chỉ đọc, không tốn gas
5. **Token / Allowlist** — xem balance, bật/tắt allowlist cho 1 ví
6. **Treasury / Pause** — xem số dư USDC Treasury, pause/unpause Token+MintManager+RedeemManager

## Luồng test thông thường

1. Tab 1: Post 1 `LotAttestation` (điền `allowanceRecipient` = địa chỉ `recipient` lấy từ sidebar)
2. Tab 5: Allowlist địa chỉ `recipient`
3. Tab 2: Faucet USDC cho `safe`, rồi Mint
4. Tab 3: Redeem (chọn "Gọi với tư cách" = `recipient`)
5. Tab 1: finalRelease cho đúng `intentId` đó

## Script xác minh nhanh (không qua UI)

`smoke-test.mjs` và `smoke-test-2.mjs` chạy thẳng qua đúng ABI/logic ký mà UI dùng, không cần mở trình duyệt — hữu ích để kiểm tra lại sau khi đổi ABI hay logic ký:

```bash
node smoke-test.mjs     # mint flow
node smoke-test-2.mjs   # redeem / revoke / finalRelease / ceremony
```

(Mỗi lần chạy dùng `intentId` mới trong file, vì `intentId` không tái sử dụng được sau khi đã ghi.)
