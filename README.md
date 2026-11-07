# 紅酒收藏管理

公開的酒庫管理網頁：任何人都能瀏覽酒款與庫存；用「裝置密碼」登入後才能新增、編輯、出庫、上傳照片。

- **網頁**：`main` 分支，以 GitHub Pages 發布。
- **資料**：`data` 分支的 `data/wines.json`，照片在 `images/`。每次異動都是一筆 commit，commit 訊息記錄內容、出庫原因與操作的裝置，[data 分支的 commit 歷史](../../commits/data)就是異動紀錄。

## 運作方式

| 項目 | 做法 |
|---|---|
| 瀏覽 | 免登入，透過 GitHub API 讀取 `data` 分支。訪客每分鐘檢查一次更新 |
| 管理登入 | 選擇裝置並輸入該裝置的密碼，解開加密存放在 `data/keys.json` 的 GitHub 權杖 |
| 寫入 | 讀最新版本，套用變更後帶 sha 寫回；有人同時修改時自動重試，不會扣錯庫存 |
| 同步 | 登入後每 15 秒檢查一次更新，切回網頁時立即檢查 |
| 出庫 | 原因必填；系統拒絕負庫存；庫存歸零自動移入歷史酒單 |
| QR 標籤 | 每款酒的永久網址（`…/#W005`），張數依目前瓶數，可直接列印 |

### 裝置密碼的安全性

GitHub 權杖用隨機金鑰以 AES-GCM 加密；每台裝置的密碼經 PBKDF2-SHA256（600,000 次）衍生出金鑰，再把這把隨機金鑰包起來。

- `keys.json` 是公開的，所以**密碼要夠長**（至少 10 個字元，建議用一句話）。
- 權杖只授權這個 repo 的 Contents，最壞情況是資料被亂改，可以從 git 歷史還原。
- 所有裝置共用同一個權杖。「管理員／編輯者」的差別只在網頁介面上，不是硬性權限。
- 刪除裝置後，那台裝置就無法再登入。如果裝置遺失，請也更換權杖。

## 第一次設定

1. **開啟 GitHub Pages**：repo 的 Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾 `/ (root)`。
2. **建立權杖**：到 GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)
   - Repository access：Only select repositories → 這個 repo
   - Permissions → Repository permissions → **Contents：Read and write**
   - Expiration：自訂，例如一年。到期前在網頁「管理 → 裝置密碼 → 更換 GitHub 權杖」換新的即可，裝置密碼不用重設。
3. **初始設定**：開啟網頁，按右上角「初始設定」，貼上權杖、輸入這台裝置的名稱與管理員密碼。
4. **加入其他裝置**：「管理 → 裝置密碼」新增，例如「客廳 iPad」「小明手機」，把密碼告訴使用那台裝置的人。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html`、`style.css`、`app.js` | 網頁 |
| `config.js` | repo 名稱、分支、同步間隔 |
| `vendor/qrcode.min.js` | QR 碼產生器（qrcodejs 1.0.0，MIT） |
| `data` 分支 `data/wines.json` | 酒款、位置、櫃位清單 |
| `data` 分支 `data/keys.json` | 加密的權杖與裝置密碼（初始設定後產生） |
| `data` 分支 `images/` | 酒款照片 |
