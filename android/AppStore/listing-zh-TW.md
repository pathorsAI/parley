# zh-TW Play Store listing

Copy each field into the **Chinese (Traditional) – Taiwan** listing in Play
Console (Grow → Store presence → Main store listing). This is a peer of
[`listing-en.md`](listing-en.md), not a translation of it — the Chinese is
written as Chinese, the same way `values-zh-rTW/strings.xml` is written next to
`values/strings.xml` rather than after it.

Google Play counts CJK characters as one character each, so the same limits
apply; every field is well under them (title 15/30, short description 33/80,
full description ~1,260/4,000, release notes 145/500).

The full description is hard-wrapped here so it diffs cleanly. **Play renders
line breaks literally**, so let paragraphs reflow when you paste: keep the blank
line between paragraphs and the one-per-line bullets, drop the wrap inside a
paragraph.

| Field | Limit | Value |
| --- | --- | --- |
| App name (title) | 30 | `Parley 會議錄音與逐字稿` |
| Short description | 80 | `把面對面的會議錄成即時逐字稿；手上既有的錄音檔，也能匯入轉成文字。` |
| Full description | 4,000 | below |
| Category | — | 生產應用 (Productivity) |
| Contact email | — | contact@pathors.com |
| Privacy policy | — | https://parley.tw/privacy/ |

## Full description

Parley 把你面對面開的會錄下來，而且會議還在進行，逐字稿就已經讀得到了。

錄下這個房間

把手機放在桌上，按下錄音。逐字稿會隨著大家說話長出來，並且分辨不同的說話者，
所以你留下的是一份讀得懂、可以直接引用的紀錄，而不是一整片分不出誰講的文字。
切到別的 app 也會繼續錄，通知列上有一個帶計時器的常駐通知——麥克風開著這件事，
不會是個意外。

匯入你手上既有的錄音

音檔已經在手上了？從手機裡挑一個音訊檔，Parley 會用比即時更快的速度把它轉成
文字，跟你現場錄的會議放進同一個錄音庫。同事錄的訪談、一段語音備忘、別人傳給
你的檔案，都可以。這是 Android 版自己的功能：iPhone 版負責錄，這一版錄也匯入。

一個帳號，每一台裝置

錄音與逐字稿會同步到你的 Parley 帳號，手機上收下來的會議，在桌面版打開就能繼續
深入：可點擊時間軸的報告、雙方各自答應了什麼、待辦事項、成交情報，以及一份你這場
表現如何的評分。Parley 是為銷售、談判與面談打造的會議 copilot，手機負責的是把
現場收下來。

網路不好，不會賠掉一場會議

錄完的檔案會先寫進手機，才會送去任何地方。上傳不出去的時候，它會待在一個你看得到
的佇列裡，等連線回來自己送上去。萬一轉錄中途斷掉，麥克風也不會跟著停：錄音仍然
完整，而 app 會直接告訴你發生了什麼，不會假裝沒事。

App 裡還有

• 全介面繁體中文與英文，跟隨手機的語言設定
• 淺色與深色；Android 12 以上還會跟著你的桌布配色
• 本期方案的轉錄與分析用量
• 一份看得出誰先誰後的逐字稿，以及這場會議的長度

自己選技術堆疊

Parley 是開源專案，重點就在於「會議這一層」始終是你的。在桌面版，轉錄廠商與模型
供應商都由你依成本、隱私、語言與延遲需求自行挑選——Parley 是介面層，不是另一包
封閉的 AI 套餐。在 Android 上，登入後就能使用代管的轉錄服務，不必自備 API key，
免費額度也足夠日常使用。

它不會做的事

Parley Android 版對盒子裡有什麼講得很直白。它用手機自己的麥克風錄下這個房間：
不會錄電話，也不會擷取其他 app 的聲音。這一版還沒有播放功能——打開一筆錄音看到
的是逐字稿，不是播放器。資料夾與組織共享目前在桌面版與 iPhone 版。線上會議請交給
能正確擷取系統音訊的桌面版；手機負責的是你正坐在裡面的那個房間。

你的資料

按下錄音才會開始錄，而且它是為了在場的人都知道的會議而做的——Parley 是會議記錄
工具，不是偷錄工具。音訊與逐字稿會透過加密連線送到你的 Parley 帳號，用來轉錄與
同步；我們不販售這些資料，也不會拿去做廣告。完整說明請見隱私權政策，帳號刪除請至
https://parley.tw/privacy/。

Parley 採用 Apache-2.0 授權。原始碼：github.com/pathorsAI/parley

## Release notes — 0.1.0 (≤ 500 chars)

Parley Android 版首次推出。錄一場面對面的會議，逐字稿會邊講邊出現；手上已經有的
音訊檔，也可以匯入讓它轉成文字。所有內容都會同步到你的 Parley 帳號，手機收下的
會議，在桌面版打開就能看報告、待辦事項與分析。錄完就算斷網也不會消失：手機會先
保留，恢復連線後自動上傳。

## Notes on the choices here

- **The title carries the two search terms Taiwanese users actually type** —
  「會議錄音」and「逐字稿」— with the wordmark first. 15 characters, half the
  budget, and no claim the app cannot back.
- **Not a translation.** The English copy opens on "records the meetings you
  have in person"; the Chinese opens on 「會議還在進行，逐字稿就已經讀得到了」,
  which is the promise that lands in Chinese. Same facts, native rhythm.
- **The same three omissions as the English file**: no consent-prompt claim (the
  Android app has none), no playback, no folders/organization sharing.
- **`[TODO: confirm with Jack]`** the account-deletion URL, exactly as in
  [`listing-en.md`](listing-en.md) — `https://parley.tw/privacy/` currently
  describes deletion from the iOS app's Settings only.
