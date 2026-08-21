# classified-query 專案守則

## 檔案編碼規則（最高優先）

本專案位於 Google Drive 同步路徑，歷史檔案有 UTF-16 與 UTF-8 混雜。**任何改檔操作前後都要遵守以下規則**：

### 禁止事項
- **禁止**用 Windows PowerShell 的 `Set-Content` / `Out-File` / `Add-Content` / `Get-Content` 管線改寫任何含非 ASCII 內容的檔案。PS 5.1 預設輸出 ANSI（Big5），會把中文永久寫壞（U+FFFD 無法還原）。
- **禁止**在未確認檔案編碼前用任何腳本整檔讀寫。

### 正確做法
1. **改檔一律用 Edit / Write 工具**（會保留原編碼）。
2. 需要批次取代（如版本號 bump）時，**用 Node.js 並明確指定編碼**：
   ```js
   const fs = require('fs');
   let s = fs.readFileSync(f, 'utf8');        // 明確編碼
   s = s.replace(/\?v=21/g, '?v=22');
   fs.writeFileSync(f, s, 'utf8');            // 明確編碼
   ```
3. 讀檔前先看前幾個位元組判斷編碼：`FF FE`=UTF-16LE、`EF BB BF`=UTF-8 BOM、無 BOM 的 ASCII 開頭需進一步確認。
4. 若必須轉換編碼（如 UTF-16 → UTF-8），從 git 歷史取原始檔，用 Node 解碼後以 UTF-8 寫回，並立即驗證。

### 改檔後驗證（必做）
```bash
node --check js/app.js          # JS 語法
```
```powershell
# 中文完整性：FFFD 計數必須為 0，漢字數須合理
node -e "const s=require('fs').readFileSync('index.html','utf8');console.log((s.match(/\uFFFD/g)||[]).length,(s.match(/[\u4e00-\u9fff]/g)||[]).length)"
```
驗證不過 → 從 git 還原重來，不要嘗試修補壞檔。

## 其他慣例

- 前端版本號：改了哪個檔案就 bump index.html / admin.html 中對應的 `?v=N`（用 Edit 工具逐處改）。
- 後端（gas/Code.js）改動後：`clasp push` → `clasp deploy`（每次部署產生新 URL）→ 更新 `js/config.js` 的 GAS_URL → commit。
- 測試：python http.server 8099 + Playwright（npx 快取的 playwright + chromium-1228 executablePath），API 用 route 攔截 mock。
