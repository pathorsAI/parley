# Parley iOS — App Store 發佈指南

從零到上架的完整路徑，以及 Parley 特有的審核風險點。

## 0. 前置（一次性）

| 項目 | 說明 |
|---|---|
| Apple Developer Program | ✅ 已有（科技派斯，Team ID `SXHVCQXJHZ`） |
| App ID | ✅ 已註冊：`com.pathors.parley.ios`（explicit）+ **Sign in with Apple** capability（2026-07-27）。SIWA 的 Services ID 與 .p8 key（web flow / 後端驗證用）要用時再建 |
| App Store Connect | 建 app record：名稱「Parley」、主要語言 zh-Hant、SKU 任意 |
| 簽章 | Xcode → Settings → Accounts 登入開發者帳號後，`CODE_SIGN_STYLE: Automatic`（已設定）+ 選 Team 即可；CI 要用 fastlane match 或 App Store Connect API key 再說 |

## 1. 每次發佈的流程

```bash
cd ios/App && xcodegen generate
```

1. `project.yml` 進版：`CFBundleShortVersionString`（行銷版號）與 build number
2. Xcode 開 `Parley.xcodeproj` → 選 **Any iOS Device (arm64)** → Product → **Archive**
3. Organizer → **Distribute App** → App Store Connect → Upload（自動處理簽章與 dSYM）
4. App Store Connect → TestFlight 先內測（自己 + 團隊即裝即測，不用等審）
5. 補齊商店資料 → **Submit for Review**

CLI 等價（之後進 CI 用）：

```bash
xcodebuild -project Parley.xcodeproj -scheme Parley -destination generic/platform=iOS \
  -archivePath build/Parley.xcarchive archive
xcodebuild -exportArchive -archivePath build/Parley.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export
xcrun altool --upload-app ...   # 或 xcrun notarytool / Transporter
```

發佈節奏依 design doc D5：tag 用 `ios-v*` namespace、獨立 workflow，不碰桌機的 `release.yml`。

## 2. 商店資料清單

- 截圖：6.9"（iPhone 17 Pro Max）與 6.5" 兩組必備；用 simulator 截即可
- 描述、關鍵字、支援網址（parley.tw）、隱私政策網址（**必填**，見 §3）
- App 隱私「營養標籤」要申報：**音訊資料**（使用者內容）、**識別碼**（帳號 email）——有連 Google 登入與雲端同步就必須誠實填
- 出口合規：只用 HTTPS/標準加密 → `ITSAppUsesNonExemptEncryption: false`（已在 project.yml，送審不會再被問）

## 3. Parley 特有的審核風險（重要）

按風險排序，前兩項**不解決就會被打回來**：

1. **Guideline 4.8 — Sign in with Apple 是硬要求**。app 只有 Google 登入 → 必須同時提供 SIWA。這是 parley-internal #23：後端 Better Auth 加 Apple provider，app 加 `SignInWithAppleButton`。**送審前必須完成。**
2. **Guideline 5.1.1(v) — 帳號刪除**。有帳號系統的 app 必須提供「刪除帳號」入口（可以導到網頁，但流程要能真的刪）。後端目前沒有 delete-account 端點——要開一張 issue。
3. **錄音類 app 會被特別檢視**：
   - Review Notes 主動聲明：**不錄電話**（技術上也不可能）、麥克風只在使用者按下錄音時啟用、音訊只送使用者帳號綁定的轉錄服務
   - `NSMicrophoneUsageDescription` 文案要具體（已寫）；審核員會實測權限彈窗
   - 建議 app 內第一次錄音前加一個「確保已取得與會者同意」的提示（各國錄音同意法規不同，這也是產品該有的）
4. **背景錄音**：`UIBackgroundModes: audio` 用於錄音是合法用途，但審核員若覺得可疑會問——Review Notes 說明是會議錄音 app 即可
5. **демо帳號**：審核員需要能登入測試。給一組測試 Google 帳號，或做一個 review-mode（feature flag 顯示假資料）。DEBUG 的貼 token 後門**不能**出現在 Release build（已用 `#if DEBUG` 圍住，Release 自動剔除）
6. **付費**：目前 app 內沒有販售、沒有解鎖，免費額度是帳號屬性 → 不觸發 IAP 要求。未來若在 app 內賣訂閱，**必須走 IAP**（外部購買連結的規則逐年變動，屆時再查）

## 4. 送審前 checklist

- [ ] SIWA 完成（#23）並在登入頁與 Google 並列
- [ ] 帳號刪除入口（後端 + app 設定頁連結）
- [ ] 隱私政策頁面上線（parley.tw/privacy）
- [ ] App 隱私標籤申報完成
- [ ] 錄音同意提示
- [ ] 6.9" + 6.5" 截圖（淺色深色各拍一套挑好看的）
- [ ] TestFlight 真機測過：背景錄音、來電中斷恢復、鎖屏續錄
- [ ] Review Notes：測試帳號 + 不錄電話聲明
