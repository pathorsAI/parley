# zh-Hant App Store metadata

Copy each field into the Traditional Chinese localization in App Store Connect.
English ([`en-US.md`](en-US.md)) is the primary locale; this file is the
localization Taiwan and Hong Kong see. It is a peer of the English copy, not a
translation of it — the Chinese reads as Chinese.

Character limits below are Apple's; keep punctuation intact when copying.

| Field | Value |
| --- | --- |
| Name (≤ 30) | Parley 會議錄音逐字稿 |
| Subtitle (≤ 30) | 把面前這場會議變成逐字稿 |
| Promotional text (≤ 170) | 把手機放在桌上，逐字稿就邊講邊出現。同一套聲音也能拿來打字——在任何 App 按下麥克風，說的話就落在游標的位置。 |
| Keywords (≤ 100 bytes) | 會議錄音,逐字稿,語音轉文字,語音輸入,聽寫,會議紀錄,訪談,商務會議,同步 |
| Support URL | https://parley.tw/support/ |
| Marketing URL | https://parley.tw |
| Privacy Policy URL | https://parley.tw/privacy/ |
| Copyright | © 2026 Pathors AI |

## Description (≤ 4,000 chars)

Parley 讓 iPhone 成為面對面會議的錄音機與即時逐字稿——咖啡廳、客戶辦公室，以及那些不會有人打開筆電的桌子。

把手機放下，逐字稿就在對話進行的同時長出來。不同說話者會自動分開，你留下的是一份讀得懂、搜尋得到、可以直接引用的紀錄，而不是一整片分不出誰講的文字。

它會做的事

• 用麥克風錄下面對面會議，每一次開始前都會先請你確認已取得同意
• 會議還在進行時就有即時逐字稿，並自動分辨不同說話者
• 在任何 App 都能語音輸入：切到 Parley 鍵盤按麥克風，說的話就直接打進去；也可以設定到動作按鈕，連鍵盤都不用切
• 一個可以瀏覽、搜尋、用資料夾整理的錄音庫
• 個人與組織兩種空間，之間可以分享與搬移
• 錄完就算斷網也不會消失：手機會先排隊保留，恢復連線後自動同步
• 全介面支援繁體中文與英文，預設跟隨 iPhone 的語言
• 跟隨系統、淺色與深色外觀

自己選技術堆疊

Parley 是開源專案，重點就在於「會議這一層」始終是你的。在桌面版，轉錄廠商與模型供應商都由你依成本、隱私、語言與延遲需求自行挑選——Parley 是介面層，不是另一包封閉的 AI 套餐。在 iPhone 上，登入後就能使用代管的轉錄服務，不必自備 API key，免費額度也足夠日常使用。

一個帳號，兩台裝置

錄音與逐字稿會同步到你的 Parley 帳號，手機上錄到的會議，在 Mac 版打開就能繼續：可點擊時間軸的報告、雙方各自答應了什麼、待辦事項、成交情報，以及一份你這場表現如何的評分。

它不會做的事

Parley iOS 版對平台的限制講得很直白。iOS 不開放任何第三方 App 取得系統音訊，所以這個 App 不會錄電話、FaceTime 或其他 App 的聲音，也不會假裝做得到。線上會議請交給能正確擷取系統音訊的 Mac 版；手機負責的是你正坐在裡面的那個房間。

你的資料

沒有你確認在場所有人都同意，錄音不會開始。你可以在「設定 → 帳號 → 刪除帳號」永久刪除帳號與個人資料，詳情請見隱私權政策。

Parley 採用 Apache-2.0 授權。原始碼：github.com/pathorsAI/parley

## What's New — 1.1

語音輸入來到手機了。加入 Parley 鍵盤，就能在任何 App 聽寫——訊息、郵件、備忘錄，任何有輸入框的地方——用的是跟你會議同一套轉錄服務。設定到動作按鈕，連切鍵盤這一步都省下。

這一版還有：全介面同時支援英文與繁體中文，預設跟隨 iPhone 的語言；新的歡迎畫面會先說清楚帳號能換到什麼，再請你登入；錄音按鈕不再會是死的——登入過期時按下去會帶你重新登入，而不是毫無反應。

## What's New — 1.0（已被取代，保留備查）

Parley iOS 首次推出：面對面會議錄音、即時逐字稿、雲端同步、個人／組織錄音庫、離線重試與帳號管理。
