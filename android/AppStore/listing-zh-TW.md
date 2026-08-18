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
| Short description | 80 | `會議還在進行，逐字稿就已經讀得到了；手上既有的錄音檔也能匯入轉成文字。` |
| Full description | 4,000 | below |
| Category | — | 生產應用 (Productivity) |
| Contact email | — | contact@pathors.com |
| Privacy policy | — | https://parley.tw/privacy/ |

## Full description

會議還在進行，逐字稿就已經可以讀了。

手機放在桌上、按下錄音，說出來的話一句一句變成文字，還分得出誰在講。散會的時候你
手上是一份能直接引用的紀錄，不是一個三十分鐘的錄音檔加一片空白的記憶。

登入就有 20 小時免費轉錄額度，不必自備任何 API key。

現場錄：邊開會，逐字稿邊長出來

手機放桌上就是全部的設定。逐字稿隨著對話長出來、標記不同說話者，切到別的 app 也
繼續錄——通知列上一直有一個帶計時器的常駐通知，麥克風開著這件事永遠不會是意外。

匯入錄音：音檔丟進去就變成文字

音檔已經在手上了？從手機挑一個音訊檔，Parley 會在背景把它轉成文字，你不必陪著它
照原速跑完，轉好之後跟你現場錄的會議並排收在同一個庫裡。同事錄的訪談、一段語音
備忘、客戶傳來的檔案都可以。這是 Android 版獨有的：iPhone 版只能錄，這一版錄，
也匯入。

網路不好，不會賠掉一場會議

錄音先寫進手機，才會送去任何地方。傳不出去的時候它會待在一個你看得見的佇列裡，
等連線回來自己補上。轉錄中途斷線時，麥克風不會跟著停：音檔仍然完整，而且 app 會
直接告訴你發生了什麼事，不會假裝沒事。

手機負責收現場，桌面版負責挖深

同步到你的 Parley 帳號之後，桌面版接手：可點擊時間軸的完整報告、雙方各自答應了
什麼、待辦事項、成交情報，還有一份你這場表現如何的評分。Parley 是為銷售、談判與
面談打造的會議 copilot。

App 裡還有

• 介面完整支援繁體中文與英文，跟隨系統語言
• 淺色與深色；Android 12 以上還會跟著你的桌布配色
• 本期方案用掉多少轉錄與分析額度，隨時看得到
• 開源 Apache-2.0；桌面版的轉錄廠商與模型供應商都由你自己挑

它錄什麼、不錄什麼

它用手機自己的麥克風錄下你所在的那個房間——不錄通話，也不擷取其他 app 的聲音。
線上會議請交給能正確擷取系統音訊的桌面版。這一版還沒有播放器，打開一筆錄音看到
的是逐字稿。資料夾與組織共享目前在桌面版與 iPhone 版。

你的資料

按下錄音才會開始錄，而且它是為了在場每個人都知道的會議而做的——Parley 是會議
記錄工具，不是偷錄工具。音訊與逐字稿透過加密連線送到你的帳號，只用於轉錄與同步；
不販售，也不拿去投放廣告。帳號與其中所有內容你隨時可以自行刪除：
https://parley.tw/account-deletion/

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
- **帳號刪除網址已定案**，與 [`listing-en.md`](listing-en.md) 一致：
  `https://parley.tw/account-deletion/` 同時寫了兩個平台的 app 內刪除路徑，
  以及打不開 app 時的來信管道。
