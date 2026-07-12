# Stage Bundles — 銷售階段工作流（SPIN 缺口板與階段教練）— Design Doc

- **狀態**：Draft v1（提案，待 Brandon review 逐條拍板後拆實作票）
- **日期**：2026-07-11
- **來源**：pipeline 三輪討論的並行工作流（mini-crm.md D14/§8 預留的掛接點）；issue #137
- **一句話**：把 pipeline 從「stepper＋靜態指南」升級成**會看缺口的階段教練**——每個階段一個 bundle（缺口板＋教練規則＋退出條件），板上的空格自己會說話，教練在對的時機提醒你問對的問題、鎖住下一步。

---

## 1. 動機

pipeline lite（#133 已出貨）給了 sales 戰線：可點的 stage stepper、每階段的靜態指南（目標／該收集什麼／退出條件）、openq 卡自動 seed 待辦。這解決了「知道現在在哪一階段」，但沒解決業務真正的痛：

1. **看不見負空間**。指南列了「該收集什麼」，但收集到沒有、收集得夠不夠厚，要自己對著卡片庫心算。Discovery 結束才發現 implication 一格是空的，已經來不及。
2. **知道缺什麼 ≠ 知道怎麼問**。「去量化痛點的商業後果」是正確的廢話；業務需要的是**接著對方剛講的話**的下一句。
3. **會議會自己漂**。聊得開心 → 沒鎖下一步就掛電話；pain 還沒量化 → 被拉去報價。這些都是「當下沒有人拉你一把」的失誤，事後檢討沒有用。
4. **真教練跟填表機的差異在品質判斷**。SPIN 跑完順序不代表跑對：implication 是你自己講的（客戶沒認領）就不算數。

CRM 世界把這叫 sales methodology enforcement，做法是表單必填欄位——填表機。Parley 的不對稱優勢還是那個：**它在聽**。板可以從對話自己長出來，教練可以在對話裡當下介入。

## 2. 提案決策（S1–S12、S20 待逐條拍板；S13–S18 已拍板 2026-07-11；S19、S21 已拍板 2026-07-12）

| # | 提案 | 內容 |
|---|------|------|
| S1 | Bundle 是資料 | 一個階段 = 一個 **StageBundle**：板 schema（slots）＋教練規則＋退出條件＋預設時長＋talk-ratio 目標。資料驅動，非寫死元件；builtin 隨階段全數出廠（S18 通過後為六階段），使用者可改（S9） |
| S2 | 板是投影不是儲存 | **slot 內容 = claim base 的查詢投影**。單一真相仍是情報卡（mini-crm D7）；板不新增儲存格式，空/薄/實由掛到 slot 的卡算出。卡片新增 `slotIds?: string[]` 輕量標籤（S3） |
| S3 | slot 歸屬混合判定 | 新卡在**萃取時**就帶 slot（bundle 的 slot 清單注入抽取 prompt）；舊卡/手動卡用 slot 的粗查詢（category/side/layer）兜底＋開板時一次性補分類（快取）。純規則映射不可行：SPIN 四格與九分類不是一對一 |
| S4 | 建議問法即時生成 | 點幽靈列 → 即時生成 2–3 句問法（不預存）。輸入=slot 定義＋該 slot 已有的卡＋逐字稿尾段（對方剛講的話）；輸出沿用 finding「怎麼回」的 `SolutionReply` 形態（kind/reply/consideration）與 UI pattern |
| S5 | 教練規則跑既有 eval 引擎 | 會中規則（守門員、過早報價、SPIN 順序）比照紅線守衛：bundle → 動態 `EvalDef` 注入（`stagecoach:` 前綴），會議開始注入、結束移除。**零新管線**；本地可判的（talk-ratio、時間）走 delivery monitor 模式不花 AI |
| S6 | 時間預算 | 會議連結戰線時可設「預計時長」（預設值來自 bundle）。下一步守門員在剩 ~20% 時間、且本場尚無「具體有日期的下一步」時觸發；觸發時機用 prosody 挑空檔（`!speaking && !farendActive`，沿用 delivery monitor 的 sustained-condition 機制） |
| S7 | Talk ratio 是本地計算 | per-stage 門檻放 bundle（discovery：我方 <40%、獨白 >60s；demo 反轉）。計算沿用表達記分卡/delivery monitor 的本地訊號（`speaking`、`farendActive`、segment 歸屬），零 AI 成本 |
| S8 | 階段自動建議＝建議不代辦 | 會中：偵測「實際對話階段 ≠ 所選模板」→ 低頻提示切換（piggyback 在情報板抽取 pass 上，不另開呼叫）。會後：`update-thread` 操作提案（#134 既有項）建議推進階段。**永不自動推進** |
| S9 | 儲存沿用 template 機制 | bundles 存 config-dir `stage-bundles.json`（builtin 常數＋user override，同 todo/eval template 的 builtin/可編輯模型）。Settings 編輯器＝P3；org 共享 playbook 是這個檔案的同步問題，掛 mini-crm D13 第二輪 |
| S10 | 警示紀律 | 每條規則帶 `cooldownSec`＋每場觸發上限；transient 提示優先於 finding（不進時間軸）；同時最多一則。教練不可以變 nag——寧可漏提醒不可吵 |
| S11 | Gating | 缺口板只在「會議連結了 sales 戰線」時出現（live 右欄）；沒連戰線的 sales 會議維持現有情報板。戰線作戰室（ThreadPage）的板不受會議狀態限制，常駐 |
| S12 | Anti-goals | 不做：forecast/加權金額、stage 自動推進、lead scoring、方法論考核報表（對 rep 的 SPIN 成績單）、多方法論框架切換（MEDDICC checklist 等＝bundle 內容問題，不是新機制） |
| S13 | 板上用詞 ✅拍板 | 直接用 SPIN 術語：格頭 = **S / P / I / N**（tooltip 全稱 Situation/Problem/Implication/Need-payoff），不翻成白話；en 同術語。幽靈列 hint 維持白話說明句 |
| S14 | live 板語氣 ✅拍板 | live 右欄由 sales 情報板**直接升級**為 bundle 板（不並列 tab）。live 的主語氣是 **fill 不是 gap**——重點是「這場問到的情報有哪些已經可以填上」：新抽內容即時落格（提案中樣式＋落格 highlight）。負空間視覺（幽靈列整行）以作戰室（會前）為主場，live 只在格頭以狀態點輕量提示。objection/commitment 追蹤保留於板下 |
| S15 | P1 順序 ✅拍板 | **作戰室先**：P1＝戰線頁的板＋建議問法（§8 原案），P2 把板搬進 live 右欄。理由：兩個視圖共用約八成地基（bundle schema／slot 歸屬／板元件），先低風險鋪地基並先取得會前價值 |
| S16 | live 畫面配置 ✅拍板 | live 是**第二注意力介面**，只回答三問：局勢如何／有沒有要立刻處理的事／下一句說什麼。活動區塊收斂為四個（§4.4）：狀態帶、單一干預槽、填充板、轉錄參考層。**干預槽一次一則**（舊的收摺為歷史列、全文只在回放展開）；時間軸分析撤出 live、回放專屬 |
| S17 | checklist 併進格子 ✅拍板 | sales＋戰線場景下，todo 模板的**資訊蒐集型**項目（了解現況、挖掘痛點…）由 bundle slots 取代——同一件事不記兩本帳；todo 只留**行動型**項目（寄報價、約 demo）。自動勾選機制照常，對象改為格子＋行動項 |
| S18 | 階段分類修訂 ✅拍板 | `SalesStage` 前面**加 `prospecting`**（Lead/Prospecting：cold call、回撥、展會——還沒確認需求，電話回撥 playbook 的家）→ 六階段 `prospecting/discovery/demo/proposal/negotiation/closing`；**demo 與 proposal 確認分開**（Brandon 拍板）。**Qualification 不是獨立階段**：跟 discovery 同一通對話裡發生但服務不同對象（qualification 為了我方、discovery 為了客戶）→ 由 S20 計分卡承載。Closed Won/Lost 維持 `Thread.status`，補 `lostReason?: string`（流失原因，檢討用）。加階段是 additive，既有戰線零 migration |
| S19 | 每通電話選階段 ✅拍板 | **會議層有自己的階段**：連結戰線的 dialog 加階段選擇，預設帶 `Thread.stage` 但可改（戰線在議價、這通卻是補做的 demo）。live bundle 板跟**這通**的階段走；`Thread.stage` 只由使用者手動推進或會後 update-thread 提案推進，單通會議永不自動改戰線階段。**拍板 2026-07-12**（Brandon 實測 P1-1 後確認：錄音當下必須能看到、能選階段）；落地掛 P1-3（#147） |
| S20 | MEDDIC 計分卡（提案） | 「**事後填，缺哪格就知道下一步挖什麼**」——qualification 計分卡是**作戰室（會後）物件，不是會中板**。discovery bundle 附帶第二塊板：M/E/D/D/I/C 六格，各格為 claims＋committee 的投影（Metrics←量化 I 產出、Economic buyer/Champion←委員會角色、Identify pain←P 卡、Decision criteria/process←openq/nextmove 卡）；空格自動 seed openq。live 只跑 SPIN 填充板，MEDDIC 不進 live（S16 注意力紀律）。這把 S12 的「不做 MEDDICC checklist 機制」修正為「MEDDIC＝bundle 內容的投影板，仍非新機制」 |
| S21 | 缺口板主場＝live 情報板 ✅拍板 | **2026-07-12 Brandon 實測 P1-1 後拍板**：現況「階段」在錄音主畫面的唯一露出是補充背景 dialog 戰線下拉裡的括號，違反「藏兩層深＝不存在」鐵律；而使用者目標是**錄音當下**有教練提示還缺什麼資訊、該怎麼問。修訂 S15 的入口順序：**缺口板元件做一次、兩處掛載（自 P1-3 起）**——主場＝錄音主畫面右欄情報板（sales＋連結戰線時；含 S19 本通階段 stepper、格狀態、點格頭叫建議問法），第二現場＝ThreadPage 作戰室（複盤；幽靈列主視覺照 S14）。live 的 §4.3 slotFills 暫態與 §4.4 全畫面重排**仍留 P2**——P1-3 的 live 板是「可看」形態：顯示已入庫卡的格狀態，會中不即時更新 |
| S22 | live 板自動聚焦、密度紀律 ✅拍板 | **2026-07-13 Brandon 實測 live 板後拍板**：會中沒有注意力做「方向選擇」——每格手動點「怎麼問」不可行；全部格子同時給建議＝資訊轟炸，同樣不可行。定案：**方向全自動、使用者只選時機**——slotFills 與 focus 搭同一班 30 秒 realtime 萃取（零額外呼叫），LLM 依「階段內 slot 順序（S→P→I→N 這類固有順序）＋未填/薄優先＋跟著當下話題、跑題要拉回」判斷**唯一**該追的格，板上只用 secondary 色輕量 highlight 該格＋一句可照唸問句＋八字內原因；手動時機＝情報板重新整理鈕。**密度紀律**：一格一行（狀態點＋標籤＋最新內容截斷＋計數），僅 focus 格展開；禁止框中框、每項 chip、多色並用；goal/exit 退出 live 板（歸作戰室），BANT 區塊在銷售模式隱藏（slot 已涵蓋）。點格手動叫問法（§5 原形）保留給**作戰室**（會前，有注意力做選擇）。**修訂 2026-07-13（同日再實測）**：(a) 對話非線性——focus 升級為「下一句該說什麼」：偵測到對方**未回應的挑戰/質疑**時優先給回應建議（kind=objection，頂部回應卡），否則才追缺口（kind=gap）；(b) live 也保留**手動指定自由**——點格「行」就地生成該格問法（一次一格、再點收合，不加常駐按鈕）；(c) highlight 視覺加強為 primary 左邊條＋底色（bg-secondary 在深色主題下辨識不到） |

## 3. 資料模型

沿用 `src/lib/types.ts` 風格。**bundle 是設定資料**（同 `EvalTemplate` 一家人），不進 accounts.json。

```ts
/** 缺口板上的一格。id 以 bundle 命名空間：`discovery.problem`。 */
interface SlotDef {
  id: string;
  /** 格名（SPIN 的 S/P/I/N，或 demo 的「成功標準」…）。 */
  label: string;
  /** 這格要裝什麼——同時是幽靈列文案與萃取/補分類的語意提示。 */
  hint: string;
  /** 兜底粗查詢：符合條件的既有卡預掛進來（S3）。 */
  query: {
    categories: ClaimCategory[];
    side?: "ours" | "theirs";
    layer?: "surface" | "deep";
  };
  /** 「實」門檻：至少幾張非過期卡（預設 2）；confirmed 一張即算實。 */
  solidAt?: number;
}

/** 會中教練規則。local 型不花 AI；eval 型注入既有 eval 引擎（S5）。 */
type CoachRuleDef =
  | {
      kind: "nextstep-gate";        // S6 下一步守門員
      triggerAtRemainingPct: number; // 預設 20
      cooldownSec: number;
    }
  | {
      kind: "premature-pricing";    // 過早報價（discovery bundle 專屬）
      /** 先用關鍵字粗篩（報價/價格/多少錢/quote/pricing）再交 eval 確認。 */
      guardSlots: string[];          // 這些 slot 還空/薄時才觸發，例 ["discovery.problem","discovery.implication"]
      cooldownSec: number;
    }
  | {
      kind: "spin-order";           // SPIN 順序品質（eval 型）
      prompt: string;                // 判準寫在 bundle 裡，可編輯
      cooldownSec: number;
    }
  | {
      kind: "talk-ratio";           // S7（local 型）
      meMaxPct?: number;             // discovery: 40
      meMinPct?: number;             // demo: 55（反向）
      monologueSec: number;          // 獨白上限，預設 60
    }
  | {
      kind: "stage-mismatch";       // S8 會中版（piggyback 情報板 pass）
      cooldownSec: number;
    };

interface StageBundle {
  stage: SalesStage;
  boardTitle: string;               // 「SPIN 缺口板」「Demo 對焦板」…
  slots: SlotDef[];
  /** 退出條件（沿用現有 stageGuide.exit 文案，升級為可勾核對）。 */
  exitCriteria: string[];
  coachRules: CoachRuleDef[];
  defaultDurationMin?: number;      // S6 預計時長預設值
}

/** 出廠五份（S1）；user override 存 config-dir stage-bundles.json（S9）。 */
type StageBundleFile = { version: 1; overrides: Partial<Record<SalesStage, StageBundle>> };
```

`Claim` 增一個 optional 欄位（向後相容，accounts.json 不 migration）：

```ts
interface Claim {
  // …既有欄位…
  /** 缺口板 slot 標籤（S3）。萃取時標；補分類/手動掛也寫這裡。
   *  缺席＝從未分類（板用粗查詢兜底）；補分類的負向結果寫階段限定
   *  sentinel（如 `discovery.none`）——該階段不重送、換階段仍可再分類，
   *  「無新卡不重跑」由資料本身保證，不需獨立快取（#146 實作定案）。 */
  slotIds?: string[];
}
```

`Thread` 隨 S18 增兩個 optional 欄位（向後相容）：

```ts
type SalesStage = "prospecting" | "discovery" | "demo" | "proposal" | "negotiation" | "closing";

interface Thread {
  // …既有欄位…
  /** Closed Lost 的流失原因（S18）——檢討用，status="lost" 時 UI 提示填。 */
  lostReason?: string;
}
```

會議連結（HistoryEntry／meetingLink）隨 S19 增：這通電話的階段（預設 `Thread.stage`、可改）。

### 3.1 builtin discovery bundle（SPIN 板）草案

| slot | label（S13：直接用術語） | hint（同幽靈列文案） | 兜底 query |
|------|-------|---------------------|-----------|
| `discovery.situation` | **S**（Situation） | 對方現在怎麼做這件事。**S 是稅——功夫在會前做完（查得到/能寄信收的別在會議問），會議只留一兩句墊場** | goal(surface,theirs), relation |
| `discovery.problem` | **P**（Problem） | 對方**自己說出**的不滿與困難——誰在痛、痛在哪個環節。**別挖到第一個就停，多攤幾個痛，I 才有素材** | risk(theirs), stance |
| `discovery.implication` | **I**（Implication） | 痛不解決的量化代價（頻率×單價×總額）。**鏈式追問讓客戶自己算帳、自己嚇到；必須是客戶認領的**，我方推算的標「薄」。語氣是陪他算帳，不是打臉 | risk, goal(deep,theirs) |
| `discovery.needpayoff` | **N**（Need-payoff） | 對方**自己說出**「解掉會多好」——問完停住等他答；他的話比你講一百遍有用 | goal(deep,theirs), nextmove |
| `discovery.committee` | 決策鏈 | 誰拍板、誰把關、誰反對——沿用委員會角色；也問採購「你被交代找哪一類方案」（洩漏內部框法） | stance, relation |

`prospecting` bundle（回撥/陌生開發板）草案——**這個階段的唯一 KPI 是約到 demo**，不是成交也不是 qualify 完：

| slot | label | hint（同幽靈列文案） | 兜底 query |
|------|-------|---------------------|-----------|
| `prospecting.identity` | 身分 | 稱呼／公司／負責哪一塊——拆三步問，別一句塞三題 | relation |
| `prospecting.trigger` | 來意 | 怎麼知道我們的、為什麼是現在、誰提的 | goal(surface,theirs), openq |
| `prospecting.pain` | 痛點快掃 | 最頭痛的環節（挖到一兩個就好，深挖留給 discovery） | risk(theirs) |
| `prospecting.impact` | 量化快掃 | 頻率×單價×總額三件套；對方說「沒統計過」→ 當場一起抓大概 | risk, goal(deep,theirs) |
| `prospecting.next` | 下一步 | 約到 demo（二選一給時間）＋誰做什麼＋何時；聯絡方式綁在動作上 | nextmove |

exit criteria：約到 demo 時間＋復述對方的痛（用他的話）＋下一步三要素。coach rules：talk-ratio（聽 70 講 30）、nextstep-gate（KPI=demo）、過早介紹產品偵測。

（demo／proposal／negotiation／closing 的板各 4–5 格，內容自現有 `stageGuide.*.collect` 文案升級＋Brandon playbook 蒸餾（demo 板重點：開場先小 discovery 讓痛點 owner 講話、只 demo 他親口說的痛、收尾必談成範圍明確的 POC——「再研究研究」＝輸），實作時逐格定稿——文案已有 zh/en 兩份，見 §7 i18n 議題。）

## 4. 缺口板 UI

### 4.1 形態：格子＝已收集摘要＋幽靈列

每格顯示：
- **已掛的卡**（依 lastSupportedAt 新→舊）：一行一卡，信心 chip（已確認/推測/衝突）＋首條證據引句（hover 全文）。點卡＝既有 ClaimCard affordance（編輯/確認/標錯/改掛）。
- **幽靈列**（負空間視覺）：slot 未達「實」時，最後一列以虛線框＋淡字顯示 `hint`——一眼掃過去，哪格薄立刻浮出來。點幽靈列 → 建議問法（§5）。幽靈列是**作戰室板（會前）的主視覺**；live 板的呈現反轉為 fill 語氣，見 S14。
- **格狀態**：空（0 卡）／薄（只有 inferred、或全部過舊 >30 天、或未達 `solidAt`）／實。狀態只影響視覺（薄=琥珀點、實=綠點、空=虛線），**不做分數**（S12）。

### 4.2 兩個家（S21：live 為主場，兩處自 P1-3 一起掛）

- **Live 右欄＝主場（S11／S14 ✅直接升級；S21 ✅掛載提前到 P1-3）**：會議連結 sales 戰線時，右欄的 sales 情報板升級為 bundle 板，板頭帶 S19 的本通階段 stepper（預設 `Thread.stage`、可當場改）。P1-3 先掛「可看」形態：已入庫卡的格狀態＋點格頭叫建議問法；§4.3 的 slotFills 即時落格 P2 進場。
- **戰線作戰室（ThreadPage）＝複盤第二現場**：板取代現有靜態 stage guide 區塊（指南的 goal/exit 保留為板的頭尾）。會前看板知道這場要補什麼，會後 diff 入庫的卡即時反映（#143 的 recentIngest highlight 直接沿用）。幽靈列是作戰室的主視覺（S14）。
- **live 的主語氣是 fill**：你問到的情報即時落格——本場新抽內容以「提案中」樣式飛進對應格，落格瞬間 highlight（視覺語彙同 #143 recentIngest），會後審核 approve 才真正入庫（D8 不破）。負空間在 live 不搶戲：不顯示幽靈列整行，只在格頭用狀態點（空/薄/實）輕量提示；點格頭仍可叫出建議問法。objection/commitment 追蹤保留為板下方第二區（互補不衝突）。

### 4.3 live 更新路徑

live 情報板抽取（`runIntelExtraction`）已是全文重算模式。sales＋戰線場景下，抽取 schema 增列 `slotFills`：每項＝{slotId, text, quote, speaker}，**只進 UI 暫態**（提案中樣式），不寫 claim base。會後 diff 審核時同一批內容以正式 ops 出現（帶 slotIds），approve 才入庫——live 看得到、資料不髒。

### 4.4 live 畫面資訊配置（S16／S17，P2 一併實作）

背景：2026-07-11 實戰截圖檢討——live 畫面同時有七、八個活動區塊（時間軸分析、教練流兩張散文卡、情報板、待辦 0/9、雙輸入框…），但開會中的注意力預算只夠三、四個，且散文卡不通過「一眼測試」。原則：live 是**第二注意力介面**（主注意力在對話，螢幕只分到每次 1–2 秒餘光），畫面只回答三問——(a) 局勢如何 (b) 有沒有要立刻處理的事 (c) 下一句說什麼。

收斂為四個活動區：

| 區 | 內容 | 對應三問 |
|----|------|---------|
| **狀態帶**（頂） | 階段 chip＋elapsed/剩餘 vs 預計時長（S6）＋talk-ratio 迷你量表（S7）＋「下一步未鎖」badge。全部預注意編碼（位置/填充/顏色），餘光可讀 | (a) |
| **干預槽**（中欄上） | **一次一則**：severity 最高的教練提示，一行標題＋一句建議＋「如何回覆」展開。新的進來舊的收摺成「歷史 N 則」一行；全文與時間軸只在回放展開。頻率受 S10 紀律管 | (b) |
| **填充板**（右欄） | S14 的 bundle 板＋承諾帳本＋行動待辦。todo 的資訊蒐集項併入格子（S17）；行動項保留為板下輕量清單 | (a)(c) |
| **轉錄**（左欄） | 參考層：低對比、不搶焦點。說話者命名鈕設定完自動收合；提問輸入框保留（新增待辦入口併入其中或收進選單） | 查證用 |

撤出 live 的：時間軸分析（回放專屬）、教練發現散文全文（回放）、待辦資訊蒐集項（併入格子）。

實作歸屬：**P2**（live 板進場時一併重排中欄/左欄）；拆 P2 票時本節為 scope 依據。

## 5. 建議問法（點缺口 → 怎麼問）

- **觸發**：點幽靈列或點格頭的「怎麼問」。
- **輸入**：slot `hint`＋該 slot 已有的卡（避免問已知）＋逐字稿尾段（~最後 2 分鐘，含說話者歸屬）＋出席者稱謂。
- **輸出**：2–3 句，沿用 `SolutionReply` 形態：`reply`（可直接照唸的 zh-TW 商務語感問句，**接著對方剛講的話**）＋`consideration`（一行：這句在釣什麼）。`kind` 沿用 wargame 分類或增列 `probe`。
- **語感鐵則**（寫進 prompt）：跟上對話脈絡（引用對方剛說的詞）、開放式優先（**demo 場例外：只問封閉、已知八成答案的題**）、一次一問、不像問卷。罐頭句（「請問您的預算是多少」）＝失敗案例。
- **few-shot 素材庫**：Brandon 的實戰問法（I 鏈三件套「頻率/單價/總額」、「沒統計過」的接法、二選一約時間、「你被交代找哪一類方案」、五桶問題庫）——原文存私有 Drive（`業務 BD/sales-playbooks/pipeline-stages-and-call-playbook.md`），builtin prompt 引用時**去識別化**（附錄 B）。
- **UI**：重用 FindingSolution 的卡片樣式與 lazy cache（per slot × transcript 尾段 hash）。
- **會外**（作戰室開板、沒在通話）：同一入口，脈絡改為「下次會議的開場問法」，輸入不含逐字稿尾段。

## 6. 會中教練規則細節

| 規則 | 型 | 觸發 | 呈現 |
|------|----|------|------|
| 下一步守門員 | local | elapsed ≥ (1−20%)×預計時長，且本場未出現「具體＋有日期」的下一步（commitments/nextmove 提案均無日期），且處於空檔（`!speaking && !farendActive` 持續 ≥2s） | transient 警示：「剩 ~N 分鐘，下一步還沒鎖日期」＋一鍵帶出建議收尾問法（§5 引擎，slot=nextstep） |
| 過早報價 | local 粗篩 + eval 確認 | stage=discovery，價格詞出現且 `guardSlots` 仍空/薄；粗篩命中才起 eval 判斷是誰把話題拉去價格、pain 是否已量化 | 教練提示：拉回問法（§5）或「切到報價階段模板？」雙選項 |
| SPIN 順序品質 | eval | ME 在 I 格空/薄時開始推銷方案價值；或 implication 全部出自 ME 之口、客戶未認領 | finding（info 級）＋一行糾偏：「後果還是你講的——讓他自己說一次」 |
| Talk ratio | local | 滾動窗口 ME 發言占比越過 bundle 門檻；獨白 > `monologueSec`（沿用 steamroll 機制，門檻 per-stage 化） | 既有 delivery 提示樣式，文案帶階段脈絡（「Discovery 是聽的階段」） |
| 階段錯位 | piggyback | 情報板 pass 順帶回傳 detectedStage；連續兩次 ≠ 所選階段才提示（防抖） | 低調 banner：「聽起來已經在談報價——切換模板？」點了才切（S8） |
| 過早 demo | eval | stage=discovery/prospecting，客戶剛承認第一個痛、ME 就開始展示功能/講方案（「聽到痛就想 demo」——痛還沒放大就配方案，只會換到「不錯耶」然後沒下文） | 教練提示：「痛還沒養大——先追 I」＋帶出 I 鏈問法（§5） |
| 開放題失守 | eval（demo bundle 專屬） | demo 場 ME 問出無法預測答案的開放題（把場子交給對方然後接不住） | finding（info 級）：「這題你接得住嗎——demo 只問封閉、已知八成答案的題」 |
| S 稅超收 | eval（discovery bundle） | ME 連續問多個事實型 S 題（PBX/系統/量——會前該查好或寄信收的） | 低調提示：「事實題可以會後寄信收——把時間留給 P/I/N」 |

共通：`cooldownSec` 預設 300、每場每規則最多 2 次、同時最多顯示一則（佇列丟棄不排隊）、transient 不進時間軸不留檔。

## 7. 儲存、i18n、同步

- **儲存**：builtin bundles 為程式常數（文案走 i18n key，沿用現 `stageGuide.*` 的 zh/en 資產升級）；user override 存 config-dir `stage-bundles.json`（raw string，不 i18n——你改成什麼就是什麼）。讀取合併：override 有該 stage 就整份蓋（不做 per-slot merge，簡單可預測）。
- **Settings 編輯器**（P3）：比照 eval template 編輯器——列表＋編輯 slot 文案/門檻/規則開關。P1–P2 期間 builtin 即全部。
- **同步**：跟 todo/eval template 同命運（目前本機）；org 共享 playbook＝把這個檔案納入 mini-crm D13 第二輪的 org 通道，本文不展開。

## 8. 分期

**P1 — 板先能看（作戰室，無 live 依賴）**
1. `StageBundle` schema＋builtin discovery bundle（SPIN 板）＋prospecting bundle（回撥板，S18）＋其餘階段以現有 stageGuide 文案粗轉；內容素材＝Brandon playbook（附錄 B）
2. `Claim.slotIds`＋萃取帶 slot（餵資料/會後 diff 兩條路都標）＋開板一次性補分類（快取）
3. 缺口板元件兩處掛載（S21）：live 情報板（含 S19 本通階段 stepper；「可看」形態）＋ThreadPage 作戰室（取代靜態指南）＋幽靈列＋格狀態
4. 建議問法（會外形態：下次會議怎麼問；live 板點格頭同入口）

**P2 — 教練進會議室**
5. Live 填充板資料路徑（S11 gating＋live slotFills 暫態＋fill 語氣 S14）——板本體已於 P1-3 掛載（S21）
6. **live 畫面資訊配置重整（§4.4／S16／S17）**：狀態帶、單一干預槽、時間軸撤回放、checklist 併格、轉錄參考層化
7. 預計時長欄（連結會議 dialog）＋下一步守門員
8. Talk-ratio per-stage＋過早報價偵測

**P3 — 品質判斷與資料驅動閉環**
8. SPIN 順序品質 eval＋階段錯位建議（會中）＋update-thread 階段推進（會後，#134）
9. Settings bundle 編輯器＋stage-bundles.json override
10. org playbook 共享（掛 D13 二輪）

## 9. 成功指標

- Discovery 會議結束時 I／N 兩格非空的比率（板自己可統計，對 Brandon 自己的案子）
- 「建議問法」的採用感（主觀：生成的句子敢不敢直接唸）
- 守門員觸發的會議中，會後 nextmove 卡帶日期的比率
- 警示噪音：每場 transient ≤3 則且 Brandon 沒有想關掉它（S10 的真正驗收）

## 10. 開放問題（review 時要拍的）

> 原問題 1（SPIN 用詞）、2（live 板形態）、4（P1 順序）已於 2026-07-11 拍板 → S13、S14、S15。

1. **薄/實門檻**：`solidAt=2`、過舊=30 天是拍腦袋值——P1 期間用 AI3/喜來登卡片庫回放校準（實作票內附帶）。
2. **預計時長的家**：掛在「這場會議」（本文提案，連結 dialog 設）vs 掛在 Thread（每場繼承）？P2 動工前拍即可。
3. **builtin 文案定稿流程**：P1 採 discovery＋prospecting 先行、其餘階段自舊指南粗轉（§8 原案）；全量文案在 P1 review 時一併定稿。
4. `spin-order` eval 的誤報容忍：info 級夠低調嗎，還是 P3 再上？（P3 前拍）

> 原問題 5（demo/proposal 合併與否）已拍板：**分開**，S18 照六階段定案。

---

## 附錄 A：與現有機制的對應表（實作時的 reuse 清單）

| 本文概念 | 騎在誰身上 |
|----------|-----------|
| 教練規則注入/移除 | `buildRedlineEvals` 的 `stagecoach:` 前綴翻版（`redline.ts` 模式） |
| 空檔偵測、獨白、sustained-condition | `delivery.ts` LiveDeliveryMonitor（含校準與 steamroll 門檻） |
| 建議問法輸出形態與 UI | `SolutionReply`／`FindingSolution` cache pattern |
| live 板抽取節奏 | `runIntelExtraction` 全文重算模式＋schema 增列 |
| bundle 儲存/編輯模型 | `EvalTemplate` builtin+user 模式；config-dir JSON |
| 板的卡片 affordance 與新卡 highlight | ClaimCard／recentIngest（#143） |
| 階段文案資產 | i18n `accounts.stageGuide.*`（zh/en 已備） |
| 下一步守門員的「有日期下一步」判定 | 情報板 sales schema 的 commitments＋nextmove 提案 |
| MEDDIC 計分卡（S20） | committee 角色（既有 MEDDICC 語彙）＋claims 投影，同 SPIN 板機制 |

## 附錄 B：builtin 內容素材來源（含去識別化紀律）

builtin bundle 的 slot hints、教練規則文案、建議問法 few-shot、exit criteria，以 **Brandon 的實戰 playbook** 為 source of truth：

- 原文位置：私有 Drive `業務 BD/sales-playbooks/pipeline-stages-and-call-playbook.md`（pathors-drive repo，2026-07-11）。內容：pipeline 階段定義、電話回撥 playbook（心法/開場/SPIN 探詢/edge cases/收尾鐵則）、Discovery & Qualification（SPIN 逐格紀律、MEDDIC 計分卡、收手訊號、採購窗口用法、五桶問題庫、通路分流）、Demo 16 條 dos & don'ts。
- **去識別化紀律**：本 repo 是 public——競品名稱與競品策略、報價數字/錨點、客戶個案細節（人名/職稱/內部流程）一律**不入本文件與 builtin 文案**；只蒸餾成通用原則（如「報價錨點設在客戶心裡的數字」）。builtin few-shot 例句改寫為行業中性版本。
- 對照：prospecting bundle ← 回撥 playbook；discovery slot hints ← SPIN 逐格紀律；S20 ← MEDDIC 計分卡（「事後填，缺哪格挖哪格」）；過早 demo／開放題失守／S 稅超收三條規則 ← playbook 的雷區清單；§5 語感鐵則 ← 問法紀律（二選一、一次一問、讓他說）。
