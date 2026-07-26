# iOS App — Design Doc

- **狀態**：Draft v1（待 review 後拆 issues）
- **日期**：2026-07-25
- **來源**：YJack × Claude 一輪規劃（現況盤點 → iOS 平台限制 → 四題拍板）
- **一句話**：讓「錄音」這件事離開電腦——iPhone 負責**面對面會議**的收音與即時轉錄，桌機仍是深度分析的引擎，雲端是兩者之間唯一的接縫。

---

## 1. 動機與定位

Parley 今天的錄音能力綁在 macOS 上，因為它靠 Core Audio process tap 拿線上會議的系統音訊（[`audio/system_macos.rs`](../../src-tauri/src/audio/system_macos.rs)）。這讓一整類會議完全落在產品之外：**咖啡廳、客戶辦公室、展場、飯桌上的面對面會議**——而那正是業務最關鍵的場合，也是最不可能開筆電的場合。

iOS 版不是「把桌機塞進手機」。它是補上另一半的會議形態：

| | 桌機（macOS） | iPhone |
|---|---|---|
| 主場 | 線上會議（Zoom/Meet/Teams） | **面對面會議** |
| 音源 | mic + 系統音訊 process tap，雙聲道天然分離 | **只有 mic**（房間音），靠聲紋 diarization 分人 |
| 角色 | 駕駛艙 + 深度分析引擎 | 口袋錄音機 + 二次注意力教練 + 隨身書房 |

**定位鐵律**：iPhone 不試圖成為完整的 Parley。它做三件事——錄得到、當場看得到、事後查得到；**深度分析留在桌機**（D2）。

## 2. 決策記錄

| # | 決策 | 內容 |
|---|------|------|
| D1 | 技術路線 | ✅拍板 **Native SwiftUI 新 app**，不走 Tauri iOS。理由：背景錄音/鎖屏/中斷處理/Live Activity/耳機控制都是原生最穩；手機 UI 也不需要跟桌機 900px 三欄設計打架。代價是 AI 邏輯無法直接複用（見 D2 如何把代價壓到最小） |
| D2 | 分析分工 | ✅拍板 **手機偏向會議轉錄，複雜分析在桌機跑**。手機只跑「一個 live 迴圈」；report / action items / brief / delivery / 情報板抽取五個 DAG 節點（[`studyPipeline.ts`](../../src/lib/analysis/studyPipeline.ts)）完全不移植，由桌機開啟該場會議時自動跑完回寫雲端 |
| D3 | v1 範圍 | ✅拍板 含 **live coach feed**，但限縮為「findings 那一層」：45s 一次的 live 提醒（複用 [`ai/timeline.ts`](../../src/lib/ai/timeline.ts) 的 `SYSTEM_INTRO_LIVE` + `eventSchema` + eval templates）。**不含**情報板 slot 抽取、不含事後五節點 |
| D4 | 手機 UI 形態 | 提案 直接落實 stage-bundles S22「呼吸版 / second-attention」：一行狀態 + 一個 intervention + 可下拉的逐字稿。手機本來只能瞄一眼，這反而是設計上最誠實的螢幕 |
| D5 | 開源與 repo | ✅拍板 iOS app **開源**，放**本 repo `ios/`（monorepo）**。本 repo 早已是多產物形態（`website/`、`virtual-mic/`、`mcp/` 與桌機同居），iOS 延續慣例；sync 合約文件與兩個實作者同 repo、issue 一處追蹤。邊界不變：**cloud 仍留在 parley-internal**。iOS release 用獨立 tag namespace（`ios-v*`）與獨立 workflow，不碰現有 `release.yml` |
| D6 | 憑證與設定同步 | 提案 **API key 不上雲**（安全理由見 §9.1）。手機預設用 hosted provider（登入即可用，本來就不需要 key）；BYOK 在手機自行輸入存 **Keychain**。上雲的只有非機密設定：model 選擇、語言、eval templates、scenario bundles |
| D7 | me/them 判定 | 提案 iOS 全程走 `"mix"` 單一 STT session（Soniox diarization 已預設開啟）。「誰是我」用**錄前 3 秒 enrollment 或錄後在逐字稿上點一下指定**，同場自動套用。不在 v1 做聲紋跨場身分 |
| D8 | 音檔格式 | 提案 維持 **Ogg/Opus 16k mono**，與桌機 [`replay_audio.rs`](../../src-tauri/src/replay_audio.rs) 及 `PUT /recordings/:id/audio` 的 `audio/ogg` 契約一致，避免雲端多一條轉檔路徑 |
| D9 | 落檔策略 | 提案 **邊錄邊寫檔**，不學桌機把整場 PCM 常駐記憶體（`RecorderBuf`，16kHz×2B = 115MB/hr）——手機會被 jetsam 殺掉 |
| D10 | 商業模式 | 待拍板（§9.2）建議 v1 **不在 app 內販售**，只讓已有帳號登入使用免費/既有額度，避開 IAP 抽成與審核風險 |
| D11 | Anti-goals | 不做：錄電話（iOS 根本禁止）、線上會議的系統音訊（技術不可能，§3.1）、情報板/客戶戰情層（等 accounts 上雲，Phase 3）、虛擬麥克風/即時翻譯、手機端批次上傳轉檔 |

## 3. iOS 平台硬限制（先講清楚不可能的事）

### 3.1 沒有系統音訊，永遠不會有

查證結論：iOS **不存在**任何第三方 app 可用的系統音訊擷取途徑。

- ReplayKit broadcast upload extension 的 `RPSampleBufferType.audioApp` 長年不可靠（多裝置/多版本回報 `processSampleBuffer` 從不以該型別被呼叫），且 extension 有 50MB 記憶體硬限
- 電話（CallKit/telephony）音訊被系統完全封鎖
- iOS 26 的錄音強化只加了 spatial audio(FOA) 與 AirPods 高音質藍牙錄音（`bluetoothHighQualityRecording`），沒有開放 app 音訊

**推論**：iPhone 上的線上會議永遠只能靠「免持擴音 + 房間收音」這種將就做法，不該當成產品主張。iOS 的主場就是面對面。

### 3.2 這件事往上傳染到 me/them

桌機有兩條天然分離的聲道，所以非 diarizing provider 也能開兩個 session 標 `"me"`/`"them"`（[`commands.rs:471`](../../src-tauri/src/commands.rs:471)）。iPhone 只有一條，只能走既有的 diarizing 拓撲：單一 session 標 `"mix"`，speaker 整數由 Soniox 給（[`commands.rs:386`](../../src-tauri/src/commands.rs:386)、[`soniox.rs:233`](../../src-tauri/src/transcription/soniox.rs:233)）。

**已知地雷**：[`intel/extract.ts:107`](../../src/lib/intel/extract.ts:107) 用 `s.source === "me" ? "我" : "對方"` 組 prompt，`"mix"` 全部被標成「對方」——連使用者自己講的話。桌機 diarizing 模式今天就有這個 bug，iOS 每一場都會踩。**列為 Phase 0 前置修復**。

### 3.3 背景錄音是可以的，但要正確宣告

`UIBackgroundModes: audio` + `AVAudioSession` category `.record`（或 `.playAndRecord`）可在鎖屏/切 app 後持續錄音與維持 WebSocket。必須處理：來電中斷（`AVAudioSession.interruptionNotification`）、路由變更（拔耳機）、jetsam 前的狀態保全、以及**被系統殺掉後的 session 收尾**（見 §5.4 的 stale session 問題）。

## 4. 三方分工

```
   iPhone (Swift)                 Cloud (Worker)                Desktop (Tauri)
 ┌──────────────────┐        ┌─────────────────────┐        ┌────────────────────┐
 │ AVAudioEngine    │        │                     │        │                    │
 │  16k mono i16    │──WS───▶│ /stt/stream (DO)    │        │                    │
 │ SegmentBuilder   │◀──────│  → Soniox stt-rt-v5 │        │                    │
 │ live findings ───┼──HTTP─▶│ /v1/chat/completions│        │                    │
 │ (45s, 一個 prompt)│        │                     │        │                    │
 │ Opus/Ogg 落檔    │──PUT──▶│ R2 audio (presigned)│        │                    │
 │ meta + origin:ios│──POST─▶│ D1 recording        │        │                    │
 │                  │        │  needsAnalysis=true │        │                    │
 │ 書房唯讀 ◀────────┼──delta─│                     │◀──────│ 開啟 → studyPipeline│
 │ (report/actions) │  pull  │  回寫 report/brief   │  push  │  五節點跑完回寫     │
 └──────────────────┘        └─────────────────────┘        └────────────────────┘
```

「腦被複製」的範圍被 D2/D3 嚴格限制在**一個 prompt + 一個 zod schema**（live findings）。其餘五個分析節點只有桌機那一份。

## 5. 雲端要補的（Phase 0，iOS 開工前）

現有後端（`parley-internal/apps/cloud`，Hono + Workers + D1 + R2）已經有 STT relay、LLM proxy、帳號、org、資料夾、計費。缺的全是「第二個 client」才會暴露的東西。

### 5.0 合約先文件化

sync 合約目前只以註解形式散在 `src/lib/cloud/*`。iOS 是第二個實作者，必須有單一事實來源：新增 `docs/design/cloud-sync-contract.md`（DTO + push/pull 語意 + 錯誤碼），Swift 端寫合約測試對齊。

### 5.1 Auth（手機形狀）

| 項目 | 現況 | 要改 |
|---|---|---|
| provider | 只有 Google（`apps/cloud/src/auth.ts:34`） | **加 Sign in with Apple**——App Store 審核 4.8 對有第三方登入的 app 是硬要求 |
| redirect allowlist | 只允許 `^parley://` 與 `127.0.0.1/localhost` | 加 `parley-ios://auth`（或改用 Universal Link + ASWebAuthenticationSession） |
| token 生命週期 | 不透明 session token，**無 refresh**，過期即登出 | 加 refresh token 或延長 session + silent renew。手機不能每週重新登入 |
| token 存放 | 桌機放 localStorage 明文 | iOS 一律 **Keychain**（`kSecAttrAccessibleAfterFirstUnlock`，背景錄音要能讀到） |

### 5.2 Sync 合約升級

現況是「全量清單 + client 端 diff + 整包 last-writer-wins」，桌機有磁碟快取撐得住，手機撐不住。

1. **delta + tombstone 可見**：`GET /recordings?since=<updatedAt>&includeDeleted=1&limit=`。今天刪除靠「不在清單裡」傳播（`index.ts:290`），新 client 沒有全量就無法推論刪除
2. **音檔改 presigned PUT**：現在整包進 Worker 記憶體（`await c.req.arrayBuffer()`，`index.ts:364`），無分段、無續傳。手機網路下必掛
3. **新欄位**：`recording.origin: "desktop" | "ios"`、`recording.needsAnalysis: bool`、`recording.deviceId`、`recording.revision`
4. **衝突**：v1 維持整包 LWW（iOS 錄的是新 id，不會與桌機撞同一筆），但兩端 UI 要顯示「這場在另一台裝置更新過」，不要靜靜覆蓋
5. **背景 pull**：桌機目前**完全沒有 pull 側同步**，只有開 History 視窗才全量抓一次、且要點擊才下載。iOS 錄的會議必須主動出現在桌機

### 5.3 設定同步（live coach 的前置）

live findings 需要 eval templates 才有判準；scenario/stage bundles 決定教練的鏡頭。這兩份今天只活在本機（`<appConfigDir>/templates.json`、`stage-bundles.json`），完全沒上雲。

新增 `GET/PUT /settings/templates`、`GET/PUT /settings/bundles`（LWW + `updatedAt`，schema 沿用 [`bundleFile.ts`](../../src/lib/accounts/bundleFile.ts) 的純驗證模組）。**不含 API key**（D6）。

### 5.4 計費與額度（手機上線前必修，否則帳會爆）

1. **feature 歸因**：server 已讀 `X-Parley-Feature` 與 `?feature=`，但**兩端都沒送**，所有 hosted 用量落到 `other`/`meeting`。手機上線後成本歸因會完全瞎掉——先讓 client 送
2. **STT stale session reconciler**：`stt.ts:56-59` 自己標了 TODO，`reconciled` 狀態預留但**沒有 cron**。手機被系統殺掉時 DO 可能來不及 `settle()`，留下 `open` 的 `stt_session` 佔用配額（且併發上限只有 4）——手機場景會頻繁觸發，必須補 cron sweeper
3. **免費額度重算**：現在免費 20h/月 STT（Soniox $0.002/min ≈ $2.4/月）。手機把「錄音」的門檻從「開筆電」降到「按一下」，時數會數倍成長，額度與定價要重新算

## 6. iOS 端模組（Swift）

| 模組 | 內容 | 風險 |
|---|---|---|
| `AudioCapture` | AVAudioEngine → 16k mono i16（對齊 `TARGET_SAMPLE_RATE`）；`.record` + `UIBackgroundModes: audio`；中斷/路由變更/鎖屏 | 中 |
| `Recorder` | 邊錄邊寫檔（D9），結束後編 Opus/Ogg（libopus SPM）符合 `audio/ogg` 契約 | 中——libopus on iOS 要驗證 |
| `SttRelayClient` | WS → `wss://api.parley.tw/stt/stream`，Bearer session token；config frame 照 [`soniox.rs:25`](../../src-tauri/src/transcription/soniox.rs:25) 但省略 `api_key`；`{"type":"keepalive"}` 每 2s、`{"type":"finalize"}` 收尾；**relay 模式絕不關 write half**（否則最後一句被截斷） | 中 |
| `SegmentBuilder` | 移植 [`common.rs:242`](../../src-tauri/src/transcription/common.rs:242)：speaker-run 累積、同 id 重發 final、`{source}-tail` 的 partial、`<end>`/`<fin>` 驅動 endpoint | **高——最容易出錯，必須有 unit test** |
| `SpeakerIdentity` | mix 模式下指定「誰是我」（D7） | 低 |
| `LiveCoach` | 45s 一次打 `/v1/chat/completions`，複用 timeline live prompt + eval schema | 中 |
| `SyncClient` | delta pull、presigned 上傳、離線重試佇列 | 中 |
| `Library`（書房） | 列表 / 逐字稿 / 報告 / 行動項唯讀 | 低 |
| `Consent` | 麥克風權限文案、**錄音同意提示**（雙方同意法規）、隱私政策 | 低但不可略 |

## 7. 桌機端要改的

1. 開啟 `origin:"ios"` 且 `needsAnalysis` 的會議時自動跑 studyPipeline → 回寫雲端 → 清 flag
2. History 加「來自 iPhone」標記 + 背景 delta pull（§5.2-5）
3. 修 §3.2 的 `intel/extract.ts` mix→「對方」bug
4. client 開始送 `X-Parley-Feature`（§5.4-1）

## 8. 分期

| Phase | 內容 | 相依 |
|---|---|---|
| **0** | 合約文件化、SIWA + mobile redirect + refresh token、delta/tombstone pull、presigned 上傳、templates/bundles 同步、feature header、STT reconciler cron、額度重算、修 mix bug | 無 |
| **1** | iOS v1：錄音 + live 逐字稿 + live findings + 書房唯讀 + 上傳 | Phase 0 |
| **2** | 桌機側：自動分析 iOS 來源會議、背景 pull、iPhone 標記 | Phase 1 |
| **3** | accounts/情報卡上雲（mini-crm D13 round 2）→ 手機才看得到客戶戰情層；iPhone 當桌機的房間麥克風；聲紋跨場身分；Watch/耳機 haptic 提示 | Phase 2 |

估時刻意不寫在文件裡——Phase 0 的後端項目與 Phase 1 的 Swift 項目可並行，實際排程等拆 issue 時再估。

## 9. 待拍板

### 9.1 API key 要不要跟帳號同步（安全）

需求是「連接的 model 或 key 可以跟帳號同步」。**不建議同步明文 key**：Better Auth 走 Google OAuth，使用者沒有密碼可派生加密金鑰，雲端存的 key 就是伺服器可讀的明文——一旦後端被打，等於外洩使用者的 Anthropic/OpenAI 帳單權限。三個選項：

- **A（建議）**：手機預設用 hosted provider（登入即可用，不需要 key）；要 BYOK 就在手機輸入存 Keychain；只同步非機密設定（D6）
- **B**：桌機顯示配對 QR/碼 → 端到端加密後才上雲，雲端只存 ciphertext，伺服器無法解
- **C**：明文同步（不建議）

### 9.2 App Store 商業模式

app 內解鎖付費功能必須走 IAP（抽 15~30%）。建議 v1 不在 app 內販售，只讓已有帳號登入使用免費/既有額度；訂閱留在網站。另外錄音類 app 審核會被特別檢視，必須明確聲明**不錄電話**、且有錄音同意流程。

### 9.3 免費額度重定價

見 §5.4-3。手機會讓 STT 時數數倍成長，20h/月 的免費額度需要重新算過再開放註冊。
