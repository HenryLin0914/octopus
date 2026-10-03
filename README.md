# 舞蹈教室報到系統 — 部署說明

## 檔案

| 檔案 | 放哪裡 | 用途 |
|---|---|---|
| `Code.gs` | Google Sheet 的 Apps Script | 後端 API、LINE Bot Webhook、初始化分頁 |
| `index.html` | 靜態空間（GitHub Pages） | 家長端 LIFF 頁面 |
| `admin.html` | 同上 | 後台（報到、儲值、學生、請假） |
| `config.js` | 同上 | 填 GAS 網址與 LIFF ID |
| `richmenu.jpg` | 同上 | LINE 圖文選單圖片 |

> 為什麼網頁不放在 GAS 裡：GAS 的網頁會被包在 Google 的 iframe 內，LIFF 在裡面無法正常登入。所以網頁放免費的 GitHub Pages，GAS 只當 API，一樣不需要 server。

## 部署步驟

### 1. Google Sheet + Apps Script
1. 建立一個新的 Google Sheet。
2. 擴充功能 → Apps Script，把 `Code.gs` 內容整個貼上、存檔。
3. 上方函式選 `setup` → 執行（第一次會要求授權）。完成後 Sheet 會出現 14 個分頁與範例資料。
4. 再執行一次 `installTrigger`（每天凌晨自動補場次、標記過期卡）。

### 2. LINE Developers（兩個 channel 必須在同一個 Provider 底下）
1. **Messaging API channel**（官方帳號）：發一組 Channel access token (long-lived)。
2. **LINE Login channel**：記下 Channel ID；在 LIFF 分頁新增 LIFF app
   - Size：Full
   - Endpoint URL：GitHub Pages 的網址（步驟 4 取得，例 `https://帳號.github.io/dance/`）
   - Scopes：勾 `openid`、`profile`
   - Scan QR：開啟
   - 記下 LIFF ID
3. LINE Login channel 的「Linked LINE Official Account」選你的官方帳號，並把 channel 狀態改為 Published。

### 3. 指令碼屬性
Apps Script → 專案設定 → 指令碼屬性，新增：

| 屬性 | 值 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API 的 token |
| `LINE_LOGIN_CHANNEL_ID` | LINE Login channel 的 Channel ID |
| `LIFF_ID` | LIFF ID |
| `SITE_URL` | GitHub Pages 網址（圖文選單圖片從這裡讀） |

`WEBHOOK_KEY`、`QR_SECRET` 已由 setup 自動產生，不要改。

### 4. 部署
1. Apps Script → 部署 → 新增部署作業 → 類型「網頁應用程式」
   - 執行身分：我
   - 誰可以存取：所有人
   - 複製網址（`https://script.google.com/macros/s/xxx/exec`）
2. 編輯 `config.js`，填入上面的網址與 LIFF ID。
3. 把 `index.html`、`admin.html`、`config.js`、`richmenu.jpg` 上傳到 GitHub repo，開啟 GitHub Pages。
4. 把 Pages 網址填回 LIFF 的 Endpoint URL。

> 之後每次改 `Code.gs`，都要「管理部署作業 → 編輯 → 版本選新版本」，網址才不會變。

### 5. Webhook
1. Sheet 選單「舞蹈教室 → 顯示 Webhook 金鑰」。
2. Messaging API → Webhook URL 填：`<GAS網址>?key=<金鑰>`，開啟 Use webhook。
3. 官方帳號後台關閉「自動回應訊息」。
4. 按 Verify 若顯示 302 錯誤可先忽略，直接傳訊息給官方帳號測試是否有回應。

### 6. 開通後台
1. 用 LINE 開啟 `https://liff.line.me/<LIFF_ID>/admin.html`。
2. 畫面會顯示你的 userId，貼到「管理員」分頁，啟用填「是」。
3. 重新整理即可進入後台。電腦瀏覽器也可以開同一個網址（櫃檯顯示 QR Code 用）。

### 7. 圖文選單
1. 確認指令碼屬性已填 `LIFF_ID`、`SITE_URL`，且 `richmenu.jpg` 已上傳到 Pages。
2. 試算表選單「舞蹈教室 → ④ 套用 LINE 圖文選單」。
3. 六格依序是：線上報到、上課卡、出席紀錄、課表、請假、影片。要換圖就替換 `richmenu.jpg`（2500×1686）後再執行一次。

## 日常操作

- **新學生**：後台「學生」新增 → 得到 6 位數綁定碼 → 給家長 → 家長在 LINE 點「綁定學生」輸入。父母各自輸入同一組碼即可都綁定。
- **儲值**：後台「儲值」選學生與方案，堂數與金額可臨時改。
- **共用上課卡**：儲值時在「共用這張卡的學生」勾選兄弟姊妹（同一家長綁定的學生會自動列出，也可加入其他學生）。共用的學生上課都從同一張卡扣堂。試算表「上課卡」的「學生ID」欄會以逗號列出，例 `S0001,S0002`，既有的卡也可以直接改這一欄來加人。
- **線上報到**：後台「報到」→ 點名 → 顯示報到 QR Code（放櫃檯螢幕或平板）→ 家長用 LINE 掃描。QR Code 每分鐘更換，截圖轉傳會失效。
- **後台報到**：同一畫面直接按出席／請假／缺席；按錯可按「取消」，堂數會自動退回。
- **結算**：下課後按「結算」，沒到也沒請假的選課學生記為缺席。
- **選課**：在「選課」分頁填 學生ID、課程ID、狀態「啟用」。沒填選課的學生仍可臨時報到。
- **影片**：在「影片」分頁貼連結。填課程ID → 該班家長可看；填學生ID → 只有該生家長可看；都不填 → 全部家長可看。
- **停課**：把「課表場次」該列狀態改為「停課」。

## 分頁說明

| 分頁 | 誰維護 | 說明 |
|---|---|---|
| 系統設定 | 手動 | 所有規則開關，改了立即生效 |
| 選單 | 手動 | LINE 與網頁首頁的功能按鈕，可改名、排序、停用 |
| 課程 / 方案 / 選課 / 影片 / 管理員 | 手動 | 基本資料 |
| 學生名冊 | 後台新增、手動修改 | 狀態填「停用」即隱藏 |
| 課表場次 | 自動產生 | 可手動改狀態為「停課」 |
| 家長綁定 / 上課卡 / 儲值紀錄 / 出席紀錄 / 請假紀錄 | 系統寫入 | 盡量不要手動改，以免堂數不一致 |

注意：請勿更改分頁名稱與第一列欄位名稱，程式是用名稱對應的。
